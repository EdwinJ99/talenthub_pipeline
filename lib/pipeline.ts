import { PrismaClient, Prisma } from "@prisma/client";
import {
  scrapeInstagramProfileDetails,
  scrapeInstagramPosts,
  scrapeTiktokProfiles,
  RawPost,
  RawProfile,
} from "./apify";
import {
  detectEndorsePosts,
  suggestNewUsernames,
  checkIndonesianLocation,
  classifyAccountCategory,
  detectGender,
} from "./gemini";
import { computeInsightsFromPosts } from "./insights";
import {
  firstProfileImageUrl,
  persistFirstProfileImage,
} from "./profile-image";

const prisma = new PrismaClient();

export interface SeedEntry {
  username: string;
  platform: "instagram" | "tiktok";
  category?: string;
}

// Jumlah sample post yang dipakai untuk menghitung ER & metrics lainnya.
// ER selalu dihitung dari MAX_METRICS_SAMPLE post TERAKHIR yang ada di DB
// (gabungan history lama + post baru hasil scrape kali ini) — bukan cuma
// dari post yang baru saja di-scrape.
//
// Kenapa 12 (bukan 30): tools pembanding seperti HypeAuditor umumnya
// menganalisis ~12 post terakhir. Window 30 post terbukti mencakup
// rentang waktu terlalu panjang untuk akun yang sudah lama aktif (bisa
// sampai 1-2 tahun ke belakang), sehingga lebih rentan ikut menangkap
// "viral spike" historis yang sudah tidak representatif dengan performa
// akun saat ini. Window 12 post lebih fokus ke performa TERKINI.
//
// Trade-off yang disadari: window lebih kecil = lebih rentan ke sample
// kecil untuk akun yang jarang posting (mirip masalah awal sebelum
// MAX_METRICS_SAMPLE diperkenalkan). Proses scraping tetap mengambil
// hingga 30 post per scrape (lihat lib/apify.ts) untuk membangun history
// yang cukup di DB — cuma ER yang dihitung dari 24 TERAKHIR, bukan semua.
const MAX_METRICS_SAMPLE = 20;
const POST_LIMIT = 20;

function average(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

// Safety cap HANYA untuk kasus yang benar-benar mustahil/ekstrem (ER per
// post > 300%, artinya interaksi 3x lipat lebih banyak dari followers).
// Ini beda dari IQR/trimmed-mean yang sempat dicoba sebelumnya — IQR
// terbukti TIDAK konsisten: membantu akun yang punya banyak post nyimpang
// jauh (nagotejena), tapi JUSTRU merusak akun yang performanya konsisten
// tanpa outlier asli (fadiljaidi), karena IQR salah mengira variasi wajar
// sebagai anomali lalu membuang post yang sebenarnya valid.
//
// Kesimpulan: tidak ada 1 formula statistik yang cocok untuk semua akun
// sekaligus — bahkan HypeAuditor & tools sejenis pun berbeda satu sama
// lain (contoh: fadiljaidi 5.68% vs 4.05%, beda ~40% relatif). Karena itu
// kita pakai AVERAGE BIASA (formula standar industri, paling transparan &
// mudah dipertanggungjawabkan), dan hanya menjaga dari kasus yang jelas
// tidak masuk akal (>300%) sebagai pengaman terakhir — bukan mengejar
// kecocokan sempurna ke satu tool tertentu.


const MIN_FOLLOWERS = 5000;

function calculateTier(followers: number): string {
  if (followers >= 1_000_000) return "Mega";
  if (followers >= 100_000) return "Macro";
  if (followers >= 10_000) return "Micro";
  return "Nano";
}

function mostCommonLocation(posts: RawPost[]): string | null {
  const counts = new Map<string, number>();
  for (const p of posts) {
    if (!p.locationName) continue;
    counts.set(p.locationName, (counts.get(p.locationName) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

// Dipanggil di setiap titik "skip" pada processCreator. Kalau creator ini
// SUDAH ADA di mst_creators (misal dari refresh mingguan — dulu lolos
// kriteria, sekarang tidak lagi: follower turun, akun jadi private/hilang,
// atau ke-detect bukan akun Indonesia), row-nya dihapus supaya tidak lagi
// muncul di discovery/listing. Kalau belum pernah ada di DB (kandidat baru
// dari staging), findUnique return null dan fungsi ini no-op — aman
// dipanggil dari flow manapun.
async function removeCreatorIfExists(
  username: string,
  socialMedia: string,
  reason: string
) {
  const existing = await prisma.mst_creators.findUnique({
    where: {
      username_social_media: {
        username,
        social_media: socialMedia,
      },
    },
  });

  if (!existing) return;

  try {
    await prisma.$transaction(async (tx) => {
      // hapus posting creator
      await tx.dtl_creator_posts.deleteMany({
        where: {
          creator_id: existing.id,
        },
      });

      // TODO:
      // jika ada tabel lain yang punya FK creator_id,
      // tambahkan delete di sini

      await tx.mst_creators.delete({
        where: {
          id: existing.id,
        },
      });
    });

    console.log(`[DELETE] ${username} (${socialMedia}) - ${reason}`);
  } catch (err) {
    console.error(`[ERROR DELETE] ${username}`, err);
  }
}

export async function processCreator(
  entry: SeedEntry,
  preScrapedProfile?: RawProfile
) {
  console.log(`\n--- ${entry.username} (${entry.platform}) ---`);

  // 0. Cari creator lama untuk mempertahankan foto permanen jika upload
  //    foto baru gagal. last_scraped_at TIDAK digunakan sebagai filter post:
  //    setiap creator yang masuk job selalu mengambil ulang 20 post terbaru.
  const existingCreator = await prisma.mst_creators.findUnique({
    where: {
      username_social_media: {
        username: entry.username,
        social_media: entry.platform,
      },
    },
    select: {
      id: true,
      photo_url: true,
    },
  });

  // 1. Scrape PROFIL DULU AJA (murah — 1 request untuk IG, TikTok tetap gabung)
  const profile =
    preScrapedProfile ??
    (entry.platform === "instagram"
      ? (await scrapeInstagramProfileDetails([entry.username]))[0]
      : (await scrapeTiktokProfiles([entry.username], undefined, POST_LIMIT))[0]);

  if (!profile || !profile.isValid) {
    console.log("  [SKIP] username tidak valid/tidak ditemukan");
    await removeCreatorIfExists(
      entry.username,
      entry.platform,
      "username tidak valid/tidak ditemukan"
    );
    return { status: "skipped", username: entry.username };
  }

  // 1b. Filter minimal follower — di sini, akun yang kekecilan
  //     BELUM sempat kena request postingan sama sekali (untuk IG).
  if (profile.followers < MIN_FOLLOWERS) {
    console.log(
      `  [SKIP] ${profile.username} — follower ${profile.followers} < ${MIN_FOLLOWERS}`
    );
    await removeCreatorIfExists(
      profile.username,
      profile.socialMedia,
      `follower ${profile.followers} < ${MIN_FOLLOWERS}`
    );
    return { status: "skipped", username: entry.username };
  }

  // 1c. Selalu ambil ulang maksimal 20 postingan terbaru. Jangan memakai
  //     last_scraped_at sebagai onlyPostsNewerThan karena background job ini
  //     memakai pola full replacement seperti Quick Search.
  if (entry.platform === "instagram" && profile.posts.length === 0) {
    profile.posts = await scrapeInstagramPosts(
      profile.username,
      undefined,
      POST_LIMIT
    );
  }

  // Validasi hasil baru SEBELUM menyentuh post lama di database. Apabila
  // scraping gagal/kosong, lempar error agar mekanisme retry bekerja dan
  // seluruh post lama tetap aman.
  const validScrapedPosts = profile.posts
    .filter((post) => {
      if (!post.postUrl || !post.postedAt) return false;
      return Number.isFinite(new Date(post.postedAt).getTime());
    })
    .sort(
      (a, b) =>
        new Date(b.postedAt).getTime() -
        new Date(a.postedAt).getTime()
    )
    .slice(0, POST_LIMIT);

  if (validScrapedPosts.length === 0) {
    throw new Error(
      `Tidak ada postingan valid untuk ${profile.username}; data lama tidak diubah`
    );
  }

  profile.posts = validScrapedPosts;

  // 2. Cek lokasi Indonesia (Gemini)
  const locationCheck = await checkIndonesianLocation(
    profile.bio ?? "",
    profile.posts
  );
  if (!locationCheck.isIndonesian) {
    console.log(
      `  [SKIP] ${profile.username} — kemungkinan bukan akun Indonesia`
    );
    await removeCreatorIfExists(
      profile.username,
      profile.socialMedia,
      "bukan akun Indonesia"
    );
    return { status: "skipped", username: entry.username };
  }

  let cityId: number | undefined;
  const topLocation = mostCommonLocation(profile.posts);
  const cityNameToSearch = topLocation ?? locationCheck.cityGuess; // prioritas: lokasi post, fallback: tebakan Gemini dari bio

  if (cityNameToSearch) {
    const city = await prisma.mst_cities.findFirst({
      where: { name: { contains: cityNameToSearch, mode: "insensitive" } },
    });
    cityId = city?.id;
  }

  // 3. Klasifikasi kategori akun (Gemini) — SKIP kalau kategori sudah
  //    diwariskan dari luar (misal via script import yang sudah tahu
  //    kategori dari creator sumbernya).
  const existingCategories = await prisma.mst_categories.findMany();

  const chosenCategoryName =
    entry.category ??
    (await classifyAccountCategory(
      profile.username,
      profile.bio ?? "",
      profile.posts,
      existingCategories.map((c) => c.name)
    ));

  if (entry.category) {
    console.log(
      `  [INFO] kategori diwariskan: ${entry.category} (skip Gemini)`
    );
  }

  const gender = await detectGender(
    profile.username,
    profile.username,
    profile.bio ?? ""
  );
  console.log(`  [AI] gender: ${gender}`);

  const category =
    existingCategories.find(
      (c) => c.name.toLowerCase() === chosenCategoryName.toLowerCase()
    ) ??
    (await prisma.mst_categories.create({
      data: { name: chosenCategoryName },
    }));

  console.log(`  [AI] kategori: ${category.name}`);

  // 4. Deteksi endorse vs konten asli (Gemini) — dijalankan pada post yang
  //    BARU di-scrape kali ini saja (post lama di DB sudah punya flag
  //    is_endorse dari scrape sebelumnya, tidak perlu dideteksi ulang).
  const endorseResults = await detectEndorsePosts(
    profile.username,
    profile.posts
  );

  const tier = calculateTier(profile.followers);

  // URL Instagram/TikTok bersifat sementara. Salin ke Vercel Blob sebelum
  // menyimpan creator. Jika gagal, pertahankan foto permanen lama.
  const temporaryPhotoUrl = firstProfileImageUrl([
    ...(profile.photoUrls ?? []),
    profile.photoUrl,
  ]);

  const uploadedPhotoUrl = temporaryPhotoUrl
    ? await persistFirstProfileImage(
        [temporaryPhotoUrl],
        {
          username: profile.username,
          platform: entry.platform,
        }
      )
    : null;

  const permanentPhotoUrl =
    uploadedPhotoUrl ?? existingCreator?.photo_url ?? null;

  // 5. Upsert creator DULU (tanpa metrics ER/views/dll). Kita butuh
  //    creator.id buat nyimpen post di step berikutnya. Metrics dihitung
  //    dan di-UPDATE belakangan (step 8-9), setelah post baru tersimpan
  //    ke DB dan bisa digabung dengan history lama.
  const creator = await prisma.mst_creators.upsert({
    where: {
      username_social_media: {
        username: profile.username,
        social_media: profile.socialMedia,
      },
    },
    update: {
      followers: profile.followers,
      following: profile.following,
      total_post: profile.totalPost,
      // Jangan pernah menimpa foto lama dengan null ketika Blob gagal.
      ...(permanentPhotoUrl
        ? { photo_url: permanentPhotoUrl }
        : {}),
      tier,
      category_id: category.id,
      city_id: cityId,
      gender,
      updated_at: new Date(),
    },
    create: {
      username: profile.username,
      name: profile.username,
      followers: profile.followers,
      following: profile.following,
      total_post: profile.totalPost,
      photo_url: permanentPhotoUrl,
      social_media: profile.socialMedia,
      tier,
      category_id: category.id,
      city_id: cityId,
      gender,
    },
  });

  // 6. FULL REPLACEMENT POST.
  //    Hapus seluruh post lama dan insert hasil scrape baru dalam SATU
  //    transaksi. Jika satu insert gagal, delete ikut rollback sehingga
  //    data lama tidak hilang setengah jalan.
  const latestScrapedPosts = profile.posts.slice(0, POST_LIMIT);

  const replacementResult = await prisma.$transaction(
    async (tx) => {
      const deleted = await tx.dtl_creator_posts.deleteMany({
        where: { creator_id: creator.id },
      });

      for (let i = 0; i < latestScrapedPosts.length; i++) {
        const post = latestScrapedPosts[i];

        await tx.dtl_creator_posts.create({
          data: {
            creator_id: creator.id,
            caption: post.caption,
            likes: post.likes ?? 0,
            comments: post.comments ?? 0,
            views: post.views ?? 0,
            shares: post.shares ?? 0,
            saves: post.saves ?? 0,
            reposts: post.reposts ?? 0,
            post_url: post.postUrl,
            thumbnail_url: post.thumbnailUrl ?? null,
            is_endorse:
              endorseResults.find((result) => result.index === i)
                ?.isEndorse ?? false,
            posted_at: new Date(post.postedAt),
          },
        });
      }

      return {
        deleted: deleted.count,
        inserted: latestScrapedPosts.length,
      };
    },
    {
      maxWait: 10_000,
      timeout: 30_000,
    }
  );

  console.log(
    `[REPLACE] ${replacementResult.deleted} post lama dihapus; ` +
      `${replacementResult.inserted} post terbaru disimpan`
  );

  // 7. Ambil kembali maksimal 20 post hasil replacement untuk menghitung
  //    seluruh metrics dengan data terbaru yang konsisten.
  const latestPosts = await prisma.dtl_creator_posts.findMany({
    where: { creator_id: creator.id },
    orderBy: { posted_at: "desc" },
    take: MAX_METRICS_SAMPLE,
  });
  console.log(
    `  [INFO] hitung metrics dari ${latestPosts.length} post terakhir di DB`
  );

  // Post carousel/foto tunggal memang tidak punya views di Instagram, jadi
  // tidak diikutkan ke avgView/avgViewBrand (metrik views khusus video).
  const videoPosts = latestPosts.filter(
    (p) => p.views !== null && p.views !== undefined && p.views > 0
  );
  const avgView = average(videoPosts.map((p) => p.views as number));
  console.log(
    `  [INFO] ${videoPosts.length}/${latestPosts.length} post (dari sample metrics) punya data views`
  );

  const brandedVideoPosts = videoPosts.filter((p) => p.is_endorse);
  const avgViewBrand = average(brandedVideoPosts.map((p) => p.views as number));

  const insights = computeInsightsFromPosts(
    latestPosts.map((p) => ({
      caption: p.caption ?? "",

      likes: p.likes ?? 0,

      comments: p.comments ?? 0,

      views: p.views ?? 0,

      shares: p.shares ?? 0,

      saves: p.saves ?? 0,

      reposts: p.reposts ?? 0,

      postedAt: (p.posted_at ?? new Date(0)).toISOString(),

      postUrl: p.post_url ?? "",

      thumbnailUrl: p.thumbnail_url ?? undefined,
    })),
    profile.followers,
    profile.totalPost
  );

  // 9. UPDATE creator dengan metrics yang sudah dihitung dari sample DB.
  await prisma.mst_creators.update({
    where: { id: creator.id },
    data: {
      engagement_rate: insights.erFollowers,

      er_followers: insights.erFollowers,

      er_views: insights.erViews,

      er_talenthub: insights.erTalenthub,

      average_view: Math.round(avgView),

      average_view_brand: Math.round(avgViewBrand),

      avg_likes: insights.avgLikes,

      avg_comments: insights.avgComments,

      avg_shares: insights.avgShares,

      avg_saves: insights.avgSaves,

      avg_reposts: insights.avgReposts,

      top_hashtags: insights.topHashtags as any,

      top_mentions: insights.topMentions as any,

      // Baru dianggap selesai setelah creator, post, dan insight tersimpan.
      last_scraped_at: new Date(),

      updated_at: new Date(),
    },
  });

  // 10. Cari username baru dari bio/mention (pakai post yang baru
  //     di-scrape kali ini saja — tidak perlu dari latestPosts DB).
  const newUsernames = await suggestNewUsernames(
    profile.bio ?? "",
    profile.posts
  );
  for (const username of newUsernames) {
    await prisma.stg_discovered_usernames.upsert({
      where: {
        username_social_media: { username, social_media: profile.socialMedia },
      },
      update: {},
      create: {
        username,
        social_media: profile.socialMedia,
        source_creator_id: creator.id,
      },
    });
  }
  if (newUsernames.length > 0) {
    console.log(
      `  [+] ${newUsernames.length} username baru ditemukan, masuk staging`
    );
  }

  return { status: "success", username: entry.username, creatorId: creator.id };
}

export { prisma };

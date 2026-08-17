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
// yang cukup di DB — cuma ER yang dihitung dari 12 TERAKHIR, bukan semua.
const MAX_METRICS_SAMPLE = 12;

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
const MAX_ENGAGEMENT_RATE_PER_POST = 300; // dalam persen

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

const MIN_FOLLOWERS = 5000;

export async function processCreator(
  entry: SeedEntry,
  preScrapedProfile?: RawProfile
) {
  console.log(`\n--- ${entry.username} (${entry.platform}) ---`);

  // 0. Tentukan rentang tanggal post yang mau diambil:
  //    - Creator BARU (belum pernah di-scrape): sinceDate = undefined
  //      → scraper ambil sampai MAX_METRICS_SAMPLE post TERBARU apa
  //      adanya, tanpa batas tanggal (lihat lib/apify.ts).
  //    - Creator LAMA (sudah pernah di-scrape sebelumnya): sinceDate =
  //      last_scraped_at → scraper cuma narik post yang di-upload SEJAK
  //      tanggal itu, bukan histori penuh lagi. Ini yang bikin scrape
  //      berikutnya jauh lebih ringan/murah dibanding scrape pertama kali.
  //    Kalau preScrapedProfile sudah dikasih (dipanggil dari Flow 2/3 yang
  //    sudah scrape duluan), langkah ini di-skip karena tidak relevan lagi.
  let sinceDate: Date | undefined;
  if (!preScrapedProfile) {
    const existing = await prisma.mst_creators.findUnique({
      where: {
        username_social_media: {
          username: entry.username,
          social_media: entry.platform,
        },
      },
      select: { last_scraped_at: true },
    });
    if (existing?.last_scraped_at) {
      sinceDate = existing.last_scraped_at;
    }
  }

  // 1. Scrape PROFIL DULU AJA (murah — 1 request untuk IG, TikTok tetap gabung)
  const profile =
    preScrapedProfile ??
    (entry.platform === "instagram"
      ? (await scrapeInstagramProfileDetails([entry.username]))[0]
      : (await scrapeTiktokProfiles([entry.username], sinceDate))[0]);

  if (!profile || !profile.isValid) {
    console.log("  [SKIP] username tidak valid/tidak ditemukan");
    return { status: "skipped", username: entry.username };
  }

  // 1b. Filter minimal follower — di sini, akun yang kekecilan
  //     BELUM sempat kena request postingan sama sekali (untuk IG).
  if (profile.followers < MIN_FOLLOWERS) {
    console.log(
      `  [SKIP] ${profile.username} — follower ${profile.followers} < ${MIN_FOLLOWERS}`
    );
    return { status: "skipped", username: entry.username };
  }

  // 1c. Baru sekarang narik postingan Instagram — HANYA untuk akun yang
  //     sudah lolos validitas + minimal follower. Pakai sinceDate yang
  //     sama supaya konsisten dengan filter di atas. TikTok sudah otomatis
  //     punya posts dari step 1 (nggak perlu request tambahan).
  if (entry.platform === "instagram" && profile.posts.length === 0) {
    profile.posts = await scrapeInstagramPosts(profile.username, sinceDate);
  }

  // 2. Cek lokasi Indonesia (Gemini)
  const locationCheck = await checkIndonesianLocation(
    profile.bio ?? "",
    profile.posts
  );
  if (!locationCheck.isIndonesian) {
    console.log(
      `  [SKIP] ${profile.username} — kemungkinan bukan akun Indonesia`
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
    console.log(`  [INFO] kategori diwariskan: ${entry.category} (skip Gemini)`);
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
      photo_url: profile.photoUrl,
      tier,
      category_id: category.id,
      city_id: cityId,
      gender,
      last_scraped_at: new Date(),
      updated_at: new Date(),
    },
    create: {
      username: profile.username,
      name: profile.username,
      followers: profile.followers,
      following: profile.following,
      total_post: profile.totalPost,
      photo_url: profile.photoUrl,
      social_media: profile.socialMedia,
      tier,
      category_id: category.id,
      city_id: cityId,
      gender,
    },
  });

  // 6. Insert/update tiap post yang BARU di-scrape kali ini ke DB.
  let savedPosts = 0;
  for (let i = 0; i < profile.posts.length; i++) {
    const p = profile.posts[i];
    try {
      await prisma.dtl_creator_posts.upsert({
        where: {
          uq_creator_post: {
            creator_id: creator.id,
            posted_at: new Date(p.postedAt),
            caption: p.caption,
          },
        },
        update: {
          likes: p.likes,
          comments: p.comments,
          views: p.views,
          post_url: p.postUrl,
          thumbnail_url: p.thumbnailUrl,
          is_endorse:
            endorseResults.find((e) => e.index === i)?.isEndorse ?? false,
        },
        create: {
          creator_id: creator.id,
          caption: p.caption,
          likes: p.likes,
          comments: p.comments,
          views: p.views,
          post_url: p.postUrl,
          thumbnail_url: p.thumbnailUrl,
          is_endorse:
            endorseResults.find((e) => e.index === i)?.isEndorse ?? false,
          posted_at: new Date(p.postedAt),
        },
      });
      savedPosts++;
    } catch (err) {
      console.error(`  Gagal simpan post index ${i}:`, err);
    }
  }
  console.log(`  [OK] ${savedPosts}/${profile.posts.length} post baru tersimpan`);

  // 7. AMBIL MAX_METRICS_SAMPLE POST TERAKHIR dari DB (bukan cuma yang baru
  //    di-scrape kali ini). Ini kuncinya: post lama dari refresh-refresh
  //    sebelumnya ikut kehitung, jadi ER tidak lagi bias gara-gara jumlah
  //    post yang berhasil di-scrape berbeda-beda tiap kali refresh.
  const latestPosts = await prisma.dtl_creator_posts.findMany({
    where: { creator_id: creator.id },
    orderBy: { posted_at: "desc" },
    take: MAX_METRICS_SAMPLE,
  });
  console.log(
    `  [INFO] hitung metrics dari ${latestPosts.length} post terakhir di DB`
  );

  // 8. Hitung metrics dari latestPosts (bukan dari profile.posts lagi).
  //    ER = ((likes + comments + views) / followers) * 100 per post,
  //    dirata-ratakan. Views ikut di pembilang sesuai keputusan produk —
  //    post foto/carousel yang tidak punya views dianggap 0.
  // ER = ((likes + comments) / followers) * 100 — mengikuti formula
  // standar industri ("ER by Followers"), TANPA views di pembilang.
  // Views sengaja TIDAK diikutkan: nilainya jauh lebih besar dari
  // likes+comments (bisa jutaan per post untuk akun besar), sehingga kalau
  // ikut ditambahkan, ER meledak jauh dari kenyataan (terbukti dari
  // perbandingan dengan HypeAuditor & tools sejenis). Saves/shares (yang
  // dipakai formula "Extended ER") juga tidak diikutkan karena data itu
  // cuma tersedia lewat API resmi milik akun, tidak bisa didapat dari
  // scraping publik.
  // Hitung ER per post pakai formula standar ("ER by Followers"), lalu
  // cap HANYA nilai yang benar-benar mustahil (>300%) sebagai pengaman
  // terakhir. Semua post lain — termasuk yang performanya tinggi tapi
  // masih masuk akal (puluhan persen) — TETAP dihitung apa adanya, tidak
  // dibuang. Ini pilihan sadar: lebih baik sedikit lebih tinggi dari
  // "rata-rata industri" untuk akun yang memang sering viral, daripada
  // memotong data valid demi mengejar angka yang cocok ke 1 tools
  // tertentu (yang toh berbeda-beda satu sama lain).
  let anomalyCount = 0;
  const engagementRates = latestPosts.map((p) => {
    if (profile.followers <= 0) return 0;
    const rawRate = ((p.likes ?? 0) + (p.comments ?? 0)) / profile.followers * 100;
    if (rawRate > MAX_ENGAGEMENT_RATE_PER_POST) anomalyCount++;
    return Math.min(rawRate, MAX_ENGAGEMENT_RATE_PER_POST);
  });
  if (anomalyCount > 0) {
    console.log(
      `  [INFO] ${anomalyCount} post dengan ER mentah > ${MAX_ENGAGEMENT_RATE_PER_POST}% (kemungkinan reach ekstrem/anomali), sudah di-cap`
    );
  }
  const avgEngagement = average(engagementRates);

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
      views: p.views ?? undefined,
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
      engagement_rate: avgEngagement.toFixed(2),
      average_view: Math.round(avgView),
      average_view_brand: Math.round(avgViewBrand),
      avg_likes: insights.avgLikes,
      avg_comments: insights.avgComments,
      top_hashtags: insights.topHashtags as unknown as Prisma.InputJsonValue,
      top_mentions: insights.topMentions as unknown as Prisma.InputJsonValue,
      updated_at: new Date(),
    },
  });

  console.log(
    `  [OK] creator id ${creator.id}, tier ${tier}, engagement ${avgEngagement.toFixed(2)}%`
  );

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
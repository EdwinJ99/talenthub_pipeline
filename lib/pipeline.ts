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

function average(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

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
  //      → scraper pakai default 30 hari (lihat lib/apify.ts)
  //    - Creator LAMA (sudah pernah di-scrape sebelumnya): sinceDate =
  //      last_scraped_at → scraper cuma narik post yang di-upload SEJAK
  //      tanggal itu (biasanya ±7 hari, tergantung jadwal refresh kamu),
  //      bukan 30 hari penuh lagi. Ini yang bikin scrape berikutnya jadi
  //      jauh lebih ringan/murah dibanding scrape pertama kali.
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

  // 4. Deteksi endorse vs konten asli (Gemini)
  const endorseResults = await detectEndorsePosts(
    profile.username,
    profile.posts
  );

  // 5. Hitung metrics
  const engagementRates = profile.posts.map((p: RawPost) =>
    profile.followers > 0
      ? ((p.likes + p.comments) / profile.followers) * 100
      : 0
  );
  const avgEngagement = average(engagementRates);

  // Post carousel/foto tunggal memang tidak punya views di Instagram, jadi tidak diikutkan.
  const videoPosts = profile.posts.filter(
    (p: RawPost) => p.views !== undefined && p.views > 0
  );
  const allViews = videoPosts.map((p: RawPost) => p.views as number);
  const avgView = average(allViews);
  console.log(
    `  [INFO] ${videoPosts.length}/${profile.posts.length} post punya data views (video/Reels)`
  );

  const brandedVideoPosts = profile.posts.filter(
    (p: RawPost, i: number) =>
      endorseResults.find((e) => e.index === i)?.isEndorse &&
      p.views !== undefined &&
      p.views > 0
  );
  const brandedViews = brandedVideoPosts.map((p: RawPost) => p.views as number);
  const avgViewBrand = average(brandedViews);

  const tier = calculateTier(profile.followers);

  const insights = computeInsightsFromPosts(
    profile.posts,
    profile.followers,
    profile.totalPost
  );

  // 6. Insert/update ke mst_creators
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
      engagement_rate: avgEngagement.toFixed(2),
      average_view: Math.round(avgView),
      average_view_brand: Math.round(avgViewBrand),
      avg_likes: insights.avgLikes,
      avg_comments: insights.avgComments,
      top_hashtags: insights.topHashtags as unknown as Prisma.InputJsonValue,
      top_mentions: insights.topMentions as unknown as Prisma.InputJsonValue,
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
      engagement_rate: avgEngagement.toFixed(2),
      average_view: Math.round(avgView),
      average_view_brand: Math.round(avgViewBrand),
      avg_likes: insights.avgLikes,
      avg_comments: insights.avgComments,
      top_hashtags: insights.topHashtags as unknown as Prisma.InputJsonValue,
      top_mentions: insights.topMentions as unknown as Prisma.InputJsonValue,
    },
  });

  console.log(
    `  [OK] creator id ${
      creator.id
    }, tier ${tier}, engagement ${avgEngagement.toFixed(2)}%`
  );

  // 7. Insert/update tiap post
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
  console.log(`  [OK] ${savedPosts}/${profile.posts.length} post tersimpan`);

  // 8. Cari username baru dari bio/mention
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
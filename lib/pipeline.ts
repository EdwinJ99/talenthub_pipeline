import { Prisma, PrismaClient } from "@prisma/client";

import {
  enrichPosts,
  scrapeInstagramProfileDetails,
  scrapeInstagramPosts,
  scrapeTiktokProfiles,
  type RawPost,
  type RawProfile,
} from "./apify";

import {
  checkIndonesianLocation,
  classifyAccountCategory,
  detectEndorsePosts,
  detectGender,
  suggestNewUsernames,
} from "./gemini";

import { computeInsightsFromPosts } from "./insights";

import { downloadImageWithRetry, type DownloadedImage } from "./database-image";

export const prisma = new PrismaClient();

export interface SeedEntry {
  username: string;

  platform: "instagram" | "tiktok";

  category?: string;
}

type AccountCountryStatus = "indonesian" | "uncertain" | "non_indonesian";

const MIN_FOLLOWERS = 5_000;

// Maksimal post yang di-enrich dan disimpan dalam satu eksekusi.

const POST_BATCH_LIMIT = 12;

// Batas pencarian metadata. Ini bukan jumlah post yang disimpan.

const MAX_SCRAPE_DEPTH = 100;

const TOP_CONTENT_LIMIT = 5;

const ENRICHMENT_CONCURRENCY = 2;

function normalizeUsername(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

function safeMetric(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }

  return value;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function calculateTier(followers: number): string {
  if (followers >= 1_000_000) return "Mega";

  if (followers >= 100_000) return "Macro";

  if (followers >= 10_000) return "Micro";

  return "Nano";
}

function selectValidLatestPosts(
  posts: RawPost[],

  expectedUsername: string,

  limit: number
): RawPost[] {
  const expected = normalizeUsername(expectedUsername);

  const seenPostUrls = new Set<string>();

  return posts

    .filter((post) => {
      if (!post.postUrl || !post.postedAt) return false;

      if (Number.isNaN(new Date(post.postedAt).getTime())) return false;

      if (seenPostUrls.has(post.postUrl)) return false;

      const owner = normalizeUsername(post.ownerUsername ?? "");

      // Post kolaborasi tetap dipertahankan. Owner yang berbeda hanya dicatat,

      // bukan langsung dibuang, karena post tersebut bisa tampil di profil creator.

      if (owner && owner !== expected) {
        console.log(`  [COLLAB] Post dipertahankan: ${owner} -> ${expected}`);
      }

      seenPostUrls.add(post.postUrl);

      return true;
    })

    .sort(
      (a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime()
    )

    .slice(0, limit);
}

function resolveCountryStatus(locationCheck: unknown): AccountCountryStatus {
  const result = locationCheck as {
    status?: string;

    isIndonesian?: boolean;
  };

  if (
    result.status === "indonesian" ||
    result.status === "uncertain" ||
    result.status === "non_indonesian"
  ) {
    return result.status;
  }

  // Kompatibilitas sementara dengan gemini.ts lama yang baru memiliki

  // isIndonesian. Setelah gemini.ts diperbarui, status tiga kondisi dipakai.

  return result.isIndonesian ? "indonesian" : "non_indonesian";
}

async function removeCreatorIfExists(
  username: string,

  socialMedia: string,

  reason: string
): Promise<void> {
  const existing = await prisma.mst_creators.findUnique({
    where: {
      username_social_media: {
        username,

        social_media: socialMedia,
      },
    },

    select: { id: true },
  });

  if (!existing) return;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.dtl_creator_posts.deleteMany({
        where: { creator_id: existing.id },
      });

      await tx.mst_creators.delete({
        where: { id: existing.id },
      });
    });

    console.log(`[DELETE] ${username} (${socialMedia}) - ${reason}`);
  } catch (error) {
    console.error(`[ERROR DELETE] ${username}:`, error);
  }
}

async function downloadTopContentThumbnails(
  posts: RawPost[],

  platform: "instagram" | "tiktok"
): Promise<Map<string, DownloadedImage>> {
  const downloadedByPostUrl = new Map<string, DownloadedImage>();

  // Sengaja sequential agar tidak membanjiri CDN Instagram/TikTok dan

  // mengurangi kemungkinan ETIMEDOUT pada VPS.

  for (const post of posts) {
    const downloaded = await downloadImageWithRetry([post.thumbnailUrl], {
      platform,

      kind: "thumbnail",

      label: `thumbnail ${post.postUrl}`,

      attempts: 3,
    });

    if (downloaded) {
      downloadedByPostUrl.set(post.postUrl, downloaded);
    }
  }

  return downloadedByPostUrl;
}

export async function processCreator(
  entry: SeedEntry,

  preScrapedProfile?: RawProfile
) {
  const requestedUsername = normalizeUsername(entry.username);

  console.log(`\n--- ${requestedUsername} (${entry.platform}) ---`);

  const existingCreator = await prisma.mst_creators.findUnique({
    where: {
      username_social_media: {
        username: requestedUsername,

        social_media: entry.platform,
      },
    },

    select: {
      id: true,

      photo_data: true,

      photo_mime_type: true,

      photo_updated_at: true,
    },
  });

  const storedPosts = existingCreator
    ? await prisma.dtl_creator_posts.findMany({
        where: { creator_id: existingCreator.id },

        select: {
          post_url: true,

          posted_at: true,
        },

        orderBy: { posted_at: "desc" },
      })
    : [];

  // Untuk menemukan post lama di bawah data yang sudah tersimpan, scraper

  // perlu membaca melewati post yang sudah ada. Walaupun demikian, yang

  // di-enrich dan disimpan tetap maksimal POST_BATCH_LIMIT.

  const scrapeDepth = Math.min(
    MAX_SCRAPE_DEPTH,

    Math.max(POST_BATCH_LIMIT, storedPosts.length + POST_BATCH_LIMIT)
  );

  console.log(
    `  [SCRAPE] depth=${scrapeDepth}; tersimpan=${storedPosts.length}; ` +
      `batch maksimal=${POST_BATCH_LIMIT}`
  );

  const profile =
    preScrapedProfile ??
    (entry.platform === "instagram"
      ? (await scrapeInstagramProfileDetails([requestedUsername]))[0]
      : (
          await scrapeTiktokProfiles(
            [requestedUsername],

            undefined,

            scrapeDepth,

            { enrichPosts: false }
          )
        )[0]);

  if (!profile || !profile.isValid) {
    console.log("  [SKIP] Username tidak valid atau tidak ditemukan");

    await removeCreatorIfExists(
      requestedUsername,

      entry.platform,

      "username tidak valid atau tidak ditemukan"
    );

    return { status: "skipped", username: requestedUsername };
  }

  profile.username = normalizeUsername(profile.username);

  if (profile.followers < MIN_FOLLOWERS) {
    console.log(
      `  [SKIP] ${profile.username} - follower ${profile.followers} < ${MIN_FOLLOWERS}`
    );

    await removeCreatorIfExists(
      profile.username,

      profile.socialMedia,

      `follower ${profile.followers} < ${MIN_FOLLOWERS}`
    );

    return { status: "skipped", username: requestedUsername };
  }

  if (entry.platform === "instagram") {
    const scrapedInstagramPosts = await scrapeInstagramPosts(
      profile.username,

      undefined,

      scrapeDepth,

      { enrichPosts: false }
    );

    // Gabungkan bila profile-details juga membawa beberapa post.

    profile.posts = [...profile.posts, ...scrapedInstagramPosts];
  }

  const validLatestPosts = selectValidLatestPosts(
    profile.posts,

    profile.username,

    scrapeDepth
  );

  if (validLatestPosts.length === 0) {
    throw new Error(
      `Tidak ada postingan valid untuk ${profile.username}; data lama tidak diubah`
    );
  }

  /*



   * Pemilihan incremental:



   * - satu run maksimal 10 post;



   * - post baru selalu diprioritaskan;



   * - slot yang tersisa diisi post lama/missing yang belum tersimpan;



   * - jika tidak ada post baru, ambil maksimal 10 post lama;



   * - post lama di database tidak pernah dihapus.



   */

  const storedPostUrls = new Set(
    storedPosts

      .map((post) => post.post_url?.trim())

      .filter((postUrl): postUrl is string => Boolean(postUrl))
  );

  const latestStoredTimestamp = storedPosts.reduce(
    (latest, post) => Math.max(latest, post.posted_at?.getTime() ?? 0),

    0
  );

  const unprocessedPosts = validLatestPosts.filter(
    (post) => !storedPostUrls.has(post.postUrl.trim())
  );

  const newPosts = unprocessedPosts

    .filter(
      (post) =>
        storedPosts.length === 0 ||
        new Date(post.postedAt).getTime() > latestStoredTimestamp
    )

    .sort(
      (a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime()
    );

  const selectedNewPosts = newPosts.slice(0, POST_BATCH_LIMIT);

  const selectedNewUrls = new Set(
    selectedNewPosts.map((post) => post.postUrl.trim())
  );

  const remainingSlots = POST_BATCH_LIMIT - selectedNewPosts.length;

  // Termasuk post yang lebih lama dari data database dan post yang sempat

  // berlubang/gagal tersimpan di antara rentang tanggal yang sudah ada.

  const backfillPosts = unprocessedPosts

    .filter((post) => !selectedNewUrls.has(post.postUrl.trim()))

    .sort(
      (a, b) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime()
    )

    .slice(0, Math.max(0, remainingSlots));

  const postsForThisRun = [...selectedNewPosts, ...backfillPosts];

  console.log(
    `  [SELECTION] baru=${selectedNewPosts.length}; ` +
      `lama=${backfillPosts.length}; total=${postsForThisRun.length}/${POST_BATCH_LIMIT}`
  );

  if (postsForThisRun.length === 0) {
    console.log(
      `  [SKIP] ${profile.username}: tidak ada post baru atau post lama yang belum tersimpan`
    );

    return {
      status: "skipped",

      reason: "no_changes",

      username: profile.username,

      creatorId: existingCreator?.id,

      postCount: 0,
    };
  }

  profile.posts = postsForThisRun;

  // Gemini menilai asal akun dari bio dan pola bahasa caption. Lokasi post

  // tidak dipakai sebagai penentu negara karena creator bisa sedang traveling.

  const locationCheck = await checkIndonesianLocation(
    profile.bio ?? "",

    validLatestPosts
  );

  const countryStatus = resolveCountryStatus(locationCheck);

  if (countryStatus === "non_indonesian") {
    console.log(`  [SKIP] ${profile.username} - bukan akun Indonesia`);

    await removeCreatorIfExists(
      profile.username,

      profile.socialMedia,

      "terdeteksi yakin bukan akun Indonesia"
    );

    return { status: "skipped", username: requestedUsername };
  }

  if (countryStatus === "uncertain") {
    console.log(
      `  [INFO] ${profile.username} - status negara ragu, tetap disimpan`
    );
  }

  let cityId: number | null = null;

  const cityGuess = (locationCheck as { cityGuess?: string | null }).cityGuess;

  if (countryStatus === "indonesian" && cityGuess) {
    const city = await prisma.mst_cities.findFirst({
      where: {
        name: {
          contains: cityGuess,

          mode: "insensitive",
        },
      },

      select: { id: true },
    });

    cityId = city?.id ?? null;
  }

  // Hanya batch terpilih yang di-enrich; maksimal 10 post per eksekusi.

  const postsToEnrich = profile.posts.slice(0, POST_BATCH_LIMIT);

  const enrichedPosts = await enrichPosts(postsToEnrich, profile.socialMedia, {
    concurrency: ENRICHMENT_CONCURRENCY,

    dropFailed: false,

    expectedUsername: profile.username,
  });

  if (enrichedPosts.length === 0) {
    throw new Error(
      `Enrichment postingan ${profile.username} gagal; data lama tidak diubah`
    );
  }

  profile.posts = enrichedPosts;

  const existingCategories = await prisma.mst_categories.findMany({
    select: { id: true, name: true },
  });

  const chosenCategoryName =
    entry.category?.trim() ||
    (await classifyAccountCategory(
      profile.username,

      profile.bio ?? "",

      profile.posts,

      existingCategories.map((category) => category.name)
    ));

  const safeCategoryName = chosenCategoryName?.trim() || "Other";

  let category = existingCategories.find(
    (item) => item.name.toLowerCase() === safeCategoryName.toLowerCase()
  );

  if (!category) {
    category = await prisma.mst_categories.create({
      data: { name: safeCategoryName },

      select: { id: true, name: true },
    });
  }

  const gender = await detectGender(
    profile.username,

    profile.username,

    profile.bio ?? ""
  );

  console.log(`  [AI] gender: ${gender}`);

  console.log(`  [AI] kategori: ${category.name}`);

  const endorseResults = await detectEndorsePosts(
    profile.username,

    profile.posts
  );

  const downloadedProfilePhoto = await downloadImageWithRetry(
    [...(profile.photoUrls ?? []), profile.photoUrl],

    {
      platform: profile.socialMedia,

      kind: "profile",

      label: `foto profil ${profile.username}`,

      attempts: 3,
    }
  );

  const tier = calculateTier(profile.followers);

  const creatorUpdate: Prisma.mst_creatorsUncheckedUpdateInput = {
    followers: profile.followers,

    following: profile.following,

    total_post: profile.totalPost,

    tier,

    category_id: category.id,

    city_id: cityId,

    gender,

    updated_at: new Date(),
  };

  // Jika download gagal, binary lama tetap dipertahankan.

  if (downloadedProfilePhoto) {
    creatorUpdate.photo_data = downloadedProfilePhoto.data;

    creatorUpdate.photo_mime_type = downloadedProfilePhoto.mimeType;

    creatorUpdate.photo_updated_at = new Date();
  }

  const creatorCreate: Prisma.mst_creatorsUncheckedCreateInput = {
    username: profile.username,

    name: profile.username,

    followers: profile.followers,

    following: profile.following,

    total_post: profile.totalPost,

    photo_url: null,

    photo_data: downloadedProfilePhoto?.data ?? null,

    photo_mime_type: downloadedProfilePhoto?.mimeType ?? null,

    photo_updated_at: downloadedProfilePhoto ? new Date() : null,

    social_media: profile.socialMedia,

    tier,

    category_id: category.id,

    city_id: cityId,

    gender,
  };

  const creator = await prisma.mst_creators.upsert({
    where: {
      username_social_media: {
        username: profile.username,

        social_media: profile.socialMedia,
      },
    },

    update: creatorUpdate,

    create: creatorCreate,

    select: { id: true },
  });

  const hasStoredProfilePhoto = Boolean(
    downloadedProfilePhoto || existingCreator?.photo_data
  );

  if (hasStoredProfilePhoto) {
    await prisma.mst_creators.update({
      where: {
        id: creator.id,
      },

      data: {
        photo_url: `/api/media/creators/${creator.id}`,

        updated_at: new Date(),
      },
    });
  }

  // Incremental insert: post lama tidak pernah dihapus.

  const insertResult = await prisma.$transaction(
    async (tx) => {
      let inserted = 0;

      let skipped = 0;

      for (let index = 0; index < profile.posts.length; index++) {
        const post = profile.posts[index];

        const duplicate = await tx.dtl_creator_posts.findFirst({
          where: {
            creator_id: creator.id,

            post_url: post.postUrl,
          },

          select: { id: true },
        });

        if (duplicate) {
          skipped++;

          continue;
        }

        await tx.dtl_creator_posts.create({
          data: {
            creator_id: creator.id,

            caption: post.caption,

            likes: safeMetric(post.likes),

            comments: safeMetric(post.comments),

            views: safeMetric(post.views),

            shares: safeMetric(post.shares),

            saves: safeMetric(post.saves),

            reposts: safeMetric(post.reposts),

            post_url: post.postUrl,

            posted_at: new Date(post.postedAt),

            scraped_at: new Date(),

            is_endorse:
              endorseResults.find((result) => result.index === index)
                ?.isEndorse ?? false,

            is_top_content: false,

            thumbnail_url: null,

            thumbnail_data: null,

            thumbnail_mime_type: null,

            thumbnail_updated_at: null,
          },
        });

        inserted++;
      }

      return { inserted, skipped };
    },

    {
      maxWait: 10_000,

      timeout: 30_000,
    }
  );

  console.log(
    `[INCREMENTAL] ${insertResult.inserted} post disimpan; ` +
      `${insertResult.skipped} duplicate dilewati`
  );

  /*



   * Hitung ulang Top 5 dari seluruh post creator yang sudah tersimpan.

   * Binary lama dipertahankan jika post masih masuk Top 5. Binary post yang



   * keluar dari Top 5 dibersihkan agar database hanya menyimpan 5 thumbnail.



   */

  const postsForRanking = await prisma.dtl_creator_posts.findMany({
    where: { creator_id: creator.id },

    orderBy: { posted_at: "desc" },

    select: {
      id: true,

      post_url: true,

      likes: true,

      comments: true,

      views: true,

      shares: true,

      saves: true,

      reposts: true,

      posted_at: true,

      thumbnail_data: true,

      thumbnail_mime_type: true,

      thumbnail_updated_at: true,
    },
  });

  const topFiveDatabasePosts = [...postsForRanking]

    .sort((a, b) => {
      const scoreA =
        safeMetric(a.likes) +
        safeMetric(a.comments) +
        safeMetric(a.shares) +
        safeMetric(a.saves) +
        safeMetric(a.reposts) +
        safeMetric(a.views) * 0.01;

      const scoreB =
        safeMetric(b.likes) +
        safeMetric(b.comments) +
        safeMetric(b.shares) +
        safeMetric(b.saves) +
        safeMetric(b.reposts) +
        safeMetric(b.views) * 0.01;

      if (scoreB !== scoreA) return scoreB - scoreA;

      return (b.posted_at?.getTime() ?? 0) - (a.posted_at?.getTime() ?? 0);
    })

    .slice(0, TOP_CONTENT_LIMIT);

  const topContentIds = topFiveDatabasePosts.map((post) => post.id);

  const topContentUrls = new Set(
    topFiveDatabasePosts

      .map((post) => post.post_url)

      .filter((postUrl): postUrl is string => Boolean(postUrl))
  );

  const rawPostByUrl = new Map(
    validLatestPosts.map((post) => [post.postUrl, post])
  );

  const missingTopThumbnails = topFiveDatabasePosts

    .filter((post) => !post.thumbnail_data && Boolean(post.post_url))

    .map((post) => rawPostByUrl.get(post.post_url as string))

    .filter((post): post is RawPost => Boolean(post?.thumbnailUrl));

  const downloadedThumbnailByPostUrl = await downloadTopContentThumbnails(
    missingTopThumbnails,

    profile.socialMedia
  );

  await prisma.$transaction(async (tx) => {
    await tx.dtl_creator_posts.updateMany({
      where: {
        creator_id: creator.id,

        id: { notIn: topContentIds },
      },

      data: {
        is_top_content: false,

        thumbnail_url: null,

        thumbnail_data: null,

        thumbnail_mime_type: null,

        thumbnail_updated_at: null,
      },
    });

    for (const post of topFiveDatabasePosts) {
      const postUrl = post.post_url ?? "";

      const downloaded = downloadedThumbnailByPostUrl.get(postUrl);

      await tx.dtl_creator_posts.update({
        where: { id: post.id },

        data: {
          is_top_content: true,

          thumbnail_url: null,

          thumbnail_data: downloaded?.data ?? post.thumbnail_data ?? null,

          thumbnail_mime_type:
            downloaded?.mimeType ?? post.thumbnail_mime_type ?? null,

          thumbnail_updated_at: downloaded
            ? new Date()
            : post.thumbnail_updated_at ?? null,
        },
      });
    }
  });

  console.log(
    `  [TOP CONTENT] ${topContentIds.length} post ditandai; ` +
      `${downloadedThumbnailByPostUrl.size} thumbnail baru didownload`
  );

  // Metrik creator dihitung ulang dari seluruh post yang sudah tersimpan.
  // Query ini tidak menjalankan scraping/enrichment lagi, sehingga tetap ringan.
  const allStoredPosts = await prisma.dtl_creator_posts.findMany({
    where: { creator_id: creator.id },

    orderBy: { posted_at: "desc" },

    select: {
      caption: true,

      likes: true,

      comments: true,

      views: true,

      shares: true,

      saves: true,

      reposts: true,

      post_url: true,

      posted_at: true,

      is_endorse: true,
    },
  });

  console.log(
    `  [INFO] hitung metrics dari ${allStoredPosts.length} seluruh post di DB`
  );

  const videoPosts = allStoredPosts.filter(
    (post) => safeMetric(post.views) > 0
  );

  const brandedVideoPosts = videoPosts.filter((post) => post.is_endorse);

  const avgView = average(videoPosts.map((post) => safeMetric(post.views)));

  const avgViewBrand = average(
    brandedVideoPosts.map((post) => safeMetric(post.views))
  );

  const insights = computeInsightsFromPosts(
    allStoredPosts.map((post) => ({
      caption: post.caption ?? "",

      likes: safeMetric(post.likes),

      comments: safeMetric(post.comments),

      views: safeMetric(post.views),

      shares: safeMetric(post.shares),

      saves: safeMetric(post.saves),

      reposts: safeMetric(post.reposts),

      postedAt: (post.posted_at ?? new Date(0)).toISOString(),

      postUrl: post.post_url ?? "",
    })),

    profile.followers,

    allStoredPosts.length
  );

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

      top_hashtags: insights.topHashtags as unknown as Prisma.InputJsonValue,

      top_mentions: insights.topMentions as unknown as Prisma.InputJsonValue,

      last_scraped_at: new Date(),

      updated_at: new Date(),
    },
  });

  const newUsernames = await suggestNewUsernames(
    profile.bio ?? "",

    profile.posts
  );

  for (const discoveredUsername of newUsernames) {
    const username = normalizeUsername(discoveredUsername);

    if (!username || username === profile.username) continue;

    await prisma.stg_discovered_usernames.upsert({
      where: {
        username_social_media: {
          username,

          social_media: profile.socialMedia,
        },
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

  const profilePhotoSource = downloadedProfilePhoto
    ? "new"
    : existingCreator?.photo_data
    ? "existing"
    : "missing";

  console.log(
    `  [MEDIA] profil=${profilePhotoSource}; ` +
      `thumbnail=${downloadedThumbnailByPostUrl.size}/${TOP_CONTENT_LIMIT}`
  );

  return {
    status: "success",

    username: profile.username,

    creatorId: creator.id,

    postCount: profile.posts.length,

    topContentCount: topContentUrls.size,
  };
}

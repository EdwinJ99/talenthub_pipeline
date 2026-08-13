import { ApifyClient } from 'apify-client';

// ============================================================================
// ROTASI MULTI-TOKEN APIFY
// ============================================================================

import {
  callActorWithRotation,
  assertRunSucceeded,
} from "./apify-token-rotation";

// ============================================================================
// TYPES
// ============================================================================

export interface RawPost {
  caption: string;
  likes: number;
  comments: number;
  views?: number;
  postedAt: string;
  postUrl: string;
  thumbnailUrl?: string;
  locationName?: string;
}

export interface RawProfile {
  username: string;
  socialMedia: 'instagram' | 'tiktok';
  followers: number;
  following: number;
  totalPost: number;
  photoUrl?: string;
  bio?: string;
  posts: RawPost[];
  isValid: boolean;
}

// ============================================================================
// SCRAPE PROFILES
// ============================================================================

const IG_USERNAME_RE = /^[A-Za-z0-9._-]+$/;

function sanitizeUsernames(usernames: string[]): {
  valid: string[];
  invalid: string[];
} {
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of usernames) {
    const u = raw.trim().replace(/^@/, '');
    if (IG_USERNAME_RE.test(u)) {
      valid.push(u);
    } else {
      invalid.push(raw);
    }
  }
  return { valid, invalid };
}

// Cuma narik data profil (followers, bio, dll) — TIDAK ikut narik postingan.
// Ini dipakai untuk cek cepat (valid/invalid, jumlah follower) sebelum
// memutuskan apakah perlu lanjut narik postingan (yang jauh lebih berat,
// ~30+ request per akun vs 1 request di sini).
export async function scrapeInstagramProfileDetails(usernames: string[]): Promise<RawProfile[]> {
  const { valid, invalid } = sanitizeUsernames(usernames);

  if (invalid.length > 0) {
    console.warn(`  [SKIP] username invalid, dilewati: ${invalid.join(', ')}`);
  }
  if (valid.length === 0) return [];

  return callActorWithRotation(async (client) => {
    const profileRun = await client.actor('apify/instagram-scraper').call({
      directUrls: valid.map(u => `https://www.instagram.com/${u}/`),
      resultsType: 'details',
    });
    assertRunSucceeded(profileRun);
    const { items: profileItems } = await client.dataset(profileRun.defaultDatasetId).listItems();

    return profileItems.map((item: any) => ({
      username: item.username,
      socialMedia: 'instagram' as const,
      followers: item.followersCount ?? 0,
      following: item.followsCount ?? 0,
      totalPost: item.postsCount ?? 0,
      photoUrl: item.profilePicUrl,
      bio: item.biography,
      posts: [], // sengaja kosong — belum di-scrape di titik ini
      isValid: !item.error,
    }));
  });
}

// Narik postingan (Reels-only, max 30) untuk SATU username.
// Dipanggil belakangan, cuma untuk akun yang sudah lolos filter follower
// dari scrapeInstagramProfileDetails — supaya akun yang di-skip nggak
// ikut kena request post yang mahal.
//
// sinceDate (opsional): kalau creator ini SUDAH pernah di-scrape sebelumnya,
// kasih last_scraped_at di sini supaya Apify cuma narik post yang di-upload
// SEJAK tanggal itu (bukan 30 hari penuh lagi) — hemat kuota, karena post
// lama yang udah pernah ke-scrape nggak perlu ditarik ulang.
// Kalau tidak diisi (creator baru, belum pernah di-scrape), default 30 hari.
export async function scrapeInstagramPosts(
  username: string,
  sinceDate?: Date
): Promise<RawPost[]> {
  const { valid } = sanitizeUsernames([username]);
  if (valid.length === 0) return [];

  return callActorWithRotation(async (client) => {
    const onlyPostsNewerThan = sinceDate
      ? sinceDate.toISOString().split('T')[0] // format YYYY-MM-DD
      : '30 days'; // default: creator baru, belum pernah di-scrape

    const postsRun = await client.actor('apify/instagram-scraper').call({
      directUrls: [`https://www.instagram.com/${valid[0]}/`],
      resultsType: 'posts',
      resultsLimit: 30,
      onlyPostsNewerThan,
    });
    assertRunSucceeded(postsRun);
    const { items: postItems } = await client.dataset(postsRun.defaultDatasetId).listItems();

    return (postItems as any[])
      .filter(p => p.productType === 'clips') // Reels-only
      .slice(0, 30)
      .map((p: any) => ({
        caption: p.caption ?? '',
        likes: p.likesCount ?? 0,
        comments: p.commentsCount ?? 0,
        views: p.videoViewCount,
        postedAt: p.timestamp,
        postUrl: p.url,
        thumbnailUrl: p.displayUrl,
        locationName: p.locationName,
      }));
  });
}

// Dipertahankan untuk kompatibilitas — dipakai di tempat yang memang butuh
// profil + posts sekaligus dalam SATU pemanggilan (misalnya validateUsernames
// versi lama). Untuk alur processCreator yang baru, pakai
// scrapeInstagramProfileDetails + scrapeInstagramPosts secara terpisah.
export async function scrapeInstagramProfiles(usernames: string[]): Promise<RawProfile[]> {
  const profiles = await scrapeInstagramProfileDetails(usernames);
  const results: RawProfile[] = [];
  for (const profile of profiles) {
    if (!profile.isValid) {
      results.push(profile);
      continue;
    }
    const posts = await scrapeInstagramPosts(profile.username);
    results.push({ ...profile, posts });
  }
  return results;
}

// sinceDate (opsional): sama seperti scrapeInstagramPosts — TikTok actor
// tidak punya filter tanggal bawaan, jadi tetap narik semua dulu (max
// resultsPerPage), lalu difilter manual di sini berdasarkan createTimeISO.
export async function scrapeTiktokProfiles(
  usernames: string[],
  sinceDate?: Date
): Promise<RawProfile[]> {
  return callActorWithRotation(async (client) => {
    const run = await client.actor('clockworks/tiktok-scraper').call({
      profiles: usernames,
      resultsPerPage: 30,
      shouldDownloadCovers: false,
      shouldDownloadVideos: false,
    });

    assertRunSucceeded(run);

    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    const cutoffMs = sinceDate
      ? sinceDate.getTime()
      : Date.now() - 30 * 24 * 60 * 60 * 1000; // default 30 hari

    const grouped = new Map<string, any[]>();
    for (const item of items as any[]) {
      const key = item.authorMeta?.name;
      if (!key) continue;

      const postedAtMs = new Date(item.createTimeISO).getTime();
      const isWithinRange = !isNaN(postedAtMs) && postedAtMs >= cutoffMs;
      if (!isWithinRange) continue;

      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    }

    return Array.from(grouped.entries()).map(([username, posts]) => {
      const author = posts[0].authorMeta;
      return {
        username,
        socialMedia: 'tiktok' as const,
        followers: author.fans ?? 0,
        following: author.following ?? 0,
        totalPost: author.video ?? 0,
        photoUrl: author.avatar,
        bio: author.signature,
        posts: posts.map((p: any) => ({
          caption: p.text ?? '',
          likes: p.diggCount ?? 0,
          comments: p.commentCount ?? 0,
          views: p.playCount,
          postedAt: p.createTimeISO,
          postUrl: p.webVideoUrl,
          thumbnailUrl: p.videoMeta?.coverUrl ?? p.videoMeta?.originalCoverUrl,
        })),
        isValid: true,
      };
    });
  });
}

// validateUsernames cuma butuh tau valid/invalid — pakai versi profil-only
// biar nggak ikut narik postingan sama sekali (murah).
export async function validateUsernames(
  usernames: string[],
  platform: 'instagram' | 'tiktok'
): Promise<{ username: string; valid: boolean }[]> {
  if (usernames.length === 0) return [];

  const profiles =
    platform === 'instagram'
      ? await scrapeInstagramProfileDetails(usernames)
      : await scrapeTiktokProfiles(usernames);

  const foundUsernames = new Set(
    profiles.filter(p => p.isValid).map(p => p.username.toLowerCase())
  );

  return usernames.map(u => ({
    username: u,
    valid: foundUsernames.has(u.toLowerCase()),
  }));
}

// ============================================================================
// SCRAPE SINGLE CONTENT URL
// ============================================================================

export interface ContentMetrics {
  contentUrl: string;
  platform: 'instagram' | 'tiktok';
  caption: string;
  thumbnailUrl?: string;
  likes: number;
  comments: number;
  saves: number;
  reposts: number;
  views: number;
  plays: number;
  duration: number;
  shares: number;
}

function int(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
}

function normalizeContentUrl(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL content is invalid');
  return url.toString();
}

export function detectContentPlatform(value: string): 'instagram' | 'tiktok' {
  const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  if (hostname === 'instagram.com' || hostname.endsWith('.instagram.com')) return 'instagram';
  if (hostname === 'tiktok.com' || hostname.endsWith('.tiktok.com')) return 'tiktok';
  throw new Error('Only Instagram and TikTok content URLs are supported');
}

export async function scrapeContentUrl(value: string): Promise<ContentMetrics> {
  const contentUrl = normalizeContentUrl(value);
  const platform = detectContentPlatform(contentUrl);

  return callActorWithRotation(async (client) => {
    const run = platform === 'instagram'
      ? await client.actor('data-slayer/instagram-post-details').call({ urls: [contentUrl] })
      : await client.actor('clockworks/tiktok-scraper').call({
          postURLs: [contentUrl], scrapeRelatedVideos: false, resultsPerPage: 1,
          shouldDownloadCovers: false,
        });

    assertRunSucceeded(run);

    const { items } = await client.dataset(run.defaultDatasetId).listItems({ limit: 1 });
    const item = items[0] as Record<string, any> | undefined;
    if (!item) throw new Error('Content could not be found or is not public');
    if (item.error) throw new Error(String(item.error));

    if (platform === 'instagram') {
      const metrics = item.metrics ?? {};
      const caption = typeof item.caption === 'string'
        ? item.caption
        : item.caption?.text ?? item.caption?.text_translation ?? '';
      const plays = int(
        metrics.ig_play_count ?? metrics.play_count ?? item.play_count
        ?? item.plays_count ?? item.videoPlayCount
      );
      return {
        contentUrl, platform, caption,
        thumbnailUrl: item.thumbnail_url ?? item.thumbnailUrl ?? item.display_url ?? item.displayUrl
          ?? item.image_url ?? item.media_url ?? item.images?.[0],
        likes: int(metrics.like_count ?? item.like_count ?? item.likesCount ?? item.likes_count),
        comments: int(metrics.comment_count ?? item.comment_count ?? item.commentsCount ?? item.comments_count),
        saves: int(metrics.save_count ?? item.save_count ?? item.saves_count ?? item.savesCount),
        reposts: int(metrics.repost_count ?? item.repost_count ?? item.reposts_count ?? item.repostsCount),
        views: int(metrics.view_count ?? metrics.ig_play_count ?? metrics.play_count
          ?? item.view_count ?? item.views_count ?? item.videoViewCount),
        plays,
        duration: Number(item.video_duration ?? item.videoDuration ?? item.duration) || 0,
        shares: int(metrics.share_count ?? item.share_count ?? item.shares_count ?? item.sharesCount),
      };
    }

    return {
      contentUrl, platform, caption: item.text ?? item.desc ?? '',
      thumbnailUrl: item.videoMeta?.coverUrl ?? item.videoMeta?.originalCoverUrl ?? item.covers?.default,
      likes: int(item.diggCount ?? item.digg_count ?? item.stats?.diggCount),
      comments: int(item.commentCount ?? item.comment_count ?? item.stats?.commentCount),
      saves: int(item.collectCount ?? item.collect_count ?? item.stats?.collectCount),
      reposts: int(item.repostCount ?? item.repost_count ?? item.stats?.repostCount),
      views: int(item.playCount ?? item.play_count ?? item.stats?.playCount),
      plays: int(item.playCount ?? item.play_count ?? item.stats?.playCount),
      duration: Number(item.videoMeta?.duration ?? item.video?.duration ?? item.duration) || 0,
      shares: int(item.shareCount ?? item.share_count ?? item.stats?.shareCount),
    };
  });
}
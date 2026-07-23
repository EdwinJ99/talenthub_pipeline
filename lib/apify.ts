import { ApifyClient } from 'apify-client';

const client = new ApifyClient({ token: process.env.APIFY_TOKEN! });

export interface RawPost {
  caption: string;
  likes: number;
  comments: number;
  views?: number;
  postedAt: string;
  postUrl: string;
  thumbnailUrl?: string;
  locationName?: string;   // TAMBAH INI
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

export async function scrapeInstagramProfiles(usernames: string[]): Promise<RawProfile[]> {
  const run = await client.actor('apify/instagram-scraper').call({
    directUrls: usernames.map(u => `https://www.instagram.com/${u}/`),
    resultsType: 'details',
    resultsLimit: 30,
  });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();

  return items.map((item: any) => ({
    username: item.username,
    socialMedia: 'instagram' as const,
    followers: item.followersCount ?? 0,
    following: item.followsCount ?? 0,
    totalPost: item.postsCount ?? 0,
    photoUrl: item.profilePicUrl,
    bio: item.biography,
    posts: (item.latestPosts ?? []).map((p: any) => ({
      caption: p.caption ?? '',
      likes: p.likesCount ?? 0,
      comments: p.commentsCount ?? 0,
      views: p.videoViewCount,
      postedAt: p.timestamp,
      postUrl: p.url,
      thumbnailUrl: p.displayUrl,
      locationName: p.locationName,   // TAMBAH INI
    })),
    isValid: !item.error,
  }));
}

export async function scrapeTiktokProfiles(usernames: string[]): Promise<RawProfile[]> {
  const run = await client.actor('clockworks/tiktok-scraper').call({
    profiles: usernames,
    resultsPerPage: 30,
    shouldDownloadCovers: false,
    shouldDownloadVideos: false,
  });

  const { items } = await client.dataset(run.defaultDatasetId).listItems();

  const grouped = new Map<string, any[]>();
  for (const item of items as any[]) {
    const key = item.authorMeta?.name;
    if (!key) continue;
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
}

export async function validateUsernames(
  usernames: string[],
  platform: 'instagram' | 'tiktok'
): Promise<{ username: string; valid: boolean }[]> {
  if (usernames.length === 0) return [];

  const profiles =
    platform === 'instagram'
      ? await scrapeInstagramProfiles(usernames)
      : await scrapeTiktokProfiles(usernames);

  const foundUsernames = new Set(
    profiles.filter(p => p.isValid).map(p => p.username.toLowerCase())
  );

  return usernames.map(u => ({
    username: u,
    valid: foundUsernames.has(u.toLowerCase()),
  }));
}

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
  if (!process.env.APIFY_TOKEN) throw new Error('APIFY_TOKEN is not configured');

  const contentUrl = normalizeContentUrl(value);
  const platform = detectContentPlatform(contentUrl);
  // The general Instagram actor does not expose saves/reposts for a direct post.
  // This URL-specific actor returns those engagement fields and a stable thumbnail field.
  const run = platform === 'instagram'
    ? await client.actor('data-slayer/instagram-post-details').call({ urls: [contentUrl] })
    : await client.actor('clockworks/tiktok-scraper').call({
        postURLs: [contentUrl], scrapeRelatedVideos: false, resultsPerPage: 1,
        shouldDownloadCovers: false,
      });
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
}

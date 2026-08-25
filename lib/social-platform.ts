export type SocialPlatform = 'instagram' | 'tiktok' | 'youtube' | 'twitter';

export const SOCIAL_PLATFORMS = {
  instagram: { label: 'Instagram' },
  tiktok: { label: 'TikTok' },
  youtube: { label: 'YouTube' },
  twitter: { label: 'Twitter/X' },
} satisfies Record<SocialPlatform, { label: string }>;

export function normalizePlatform(value?: string | null): SocialPlatform | null {
  const platform = (value ?? '').trim().toLowerCase();
  if (platform.includes('instagram') || platform === 'ig') return 'instagram';
  if (platform.includes('tiktok') || platform.includes('tik tok') || platform === 'tt') return 'tiktok';
  if (platform.includes('youtube') || platform === 'yt') return 'youtube';
  if (platform.includes('twitter') || platform === 'x') return 'twitter';
  return null;
}

export function inferSowPlatform(value?: string | null): SocialPlatform | null {
  const sow = (value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  // Explicit platform names take priority over content-format words. For example,
  // "TikTok Story" and "TikTok Photo Carousel" must not be classified as Instagram.
  if (/tiktok|tik tok|\btt\b/.test(sow)) return 'tiktok';
  if (/youtube|\byt\b|shorts?|youtube integration/.test(sow)) return 'youtube';
  if (/twitter|tweet|\bx\b|x post|x thread/.test(sow)) return 'twitter';
  if (/instagram|\big\b|reels?|story|carousel|feed/.test(sow)) return 'instagram';
  return null;
}

export function isSowForPlatform(sow: string | null | undefined, platform: string | null | undefined) {
  const creatorPlatform = normalizePlatform(platform);
  const sowPlatform = inferSowPlatform(sow);
  // Never expose an unclassified SOW across every platform.
  return Boolean(creatorPlatform && sowPlatform && creatorPlatform === sowPlatform);
}

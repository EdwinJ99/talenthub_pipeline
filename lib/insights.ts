// Pure, dependency-free helpers for turning scraped posts into profile
// insights. No apify-client import here on purpose — this file gets used
// both on the server (API route) and in the browser (recomputing insights
// when the user switches the date-range tab), so it must stay bundle-safe.

export interface RawPostLike {
  caption: string;
  likes: number;
  comments: number;
  views?: number;
  postedAt: string;
  postUrl: string;
  thumbnailUrl?: string;
}

export interface HashtagCount {
  tag: string;
  count: number;
}

export interface MentionCount {
  mention: string;
  count: number;
}

export interface ProfileInsights {
  totalPosts: number;
  avgLikes: number;
  avgComments: number;
  avgViews: number;
  engagementRate: number; // percent
  topHashtags: HashtagCount[];
  topMentions: MentionCount[];
}

const HASHTAG_REGEX = /#([a-z0-9_]+)/gi;
const MENTION_REGEX = /@([a-z0-9_.]+)/gi;

export function extractHashtags(caption: string): string[] {
  const matches = (caption ?? "").matchAll(HASHTAG_REGEX);
  return Array.from(matches, (m) => m[1].toLowerCase());
}

export function extractMentions(caption: string): string[] {
  const matches = (caption ?? "").matchAll(MENTION_REGEX);
  return Array.from(matches, (m) => m[1].toLowerCase());
}

function topN<T extends string>(values: T[], n: number): { key: T; count: number }[] {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

/**
 * Filters posts to only those posted within the last `days` days.
 * Posts with an unparseable postedAt are kept (better to include than to
 * silently drop data because of a bad timestamp).
 */
export function filterPostsByRange<T extends RawPostLike>(posts: T[], days: number): T[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return posts.filter((p) => {
    const t = new Date(p.postedAt).getTime();
    return Number.isNaN(t) ? true : t >= cutoff;
  });
}

/**
 * Computes averages, engagement rate, top hashtags, and top mentions from
 * a set of posts.
 *
 * NOTE: this deliberately does NOT compute "reach" or "watch time" — those
 * are private analytics only available to the account owner via an
 * authenticated Business API (Instagram Insights / TikTok Analytics).
 * Public scraping cannot produce real numbers for those two fields.
 */
export function computeInsightsFromPosts(
  posts: RawPostLike[],
  followers: number,
  totalPostFallback: number,
  hashtagLimit = 10,
  mentionLimit = 5
): ProfileInsights {
  const postCount = posts.length;

  const sumLikes = posts.reduce((sum, p) => sum + (p.likes ?? 0), 0);
  const sumComments = posts.reduce((sum, p) => sum + (p.comments ?? 0), 0);
  const sumViews = posts.reduce((sum, p) => sum + (p.views ?? 0), 0);

  const avgLikes = postCount > 0 ? sumLikes / postCount : 0;
  const avgComments = postCount > 0 ? sumComments / postCount : 0;
  const avgViews = postCount > 0 ? sumViews / postCount : 0;

  const engagementRate =
    followers > 0 ? ((avgLikes + avgComments) / followers) * 100 : 0;

  const allHashtags = posts.flatMap((p) => extractHashtags(p.caption));
  const allMentions = posts.flatMap((p) => extractMentions(p.caption));

  const topHashtags: HashtagCount[] = topN(allHashtags, hashtagLimit).map(
    ({ key, count }) => ({ tag: key, count })
  );
  const topMentions: MentionCount[] = topN(allMentions, mentionLimit).map(
    ({ key, count }) => ({ mention: key, count })
  );

  return {
    totalPosts: postCount || totalPostFallback,
    avgLikes: Math.round(avgLikes),
    avgComments: Math.round(avgComments),
    avgViews: Math.round(avgViews),
    engagementRate: Number(engagementRate.toFixed(2)),
    topHashtags,
    topMentions,
  };
}

/**
 * Convenience wrapper: computes insights over ALL posts in a profile
 * (no date-range filtering).
 */
export function computeProfileInsights(
  profile: { followers: number; totalPost: number; posts: RawPostLike[] },
  hashtagLimit = 10,
  mentionLimit = 5
): ProfileInsights {
  return computeInsightsFromPosts(
    profile.posts,
    profile.followers,
    profile.totalPost,
    hashtagLimit,
    mentionLimit
  );
}
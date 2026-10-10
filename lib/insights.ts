// lib/insights.ts

export interface RawPostLike {
  caption: string;
  likes: number;
  comments: number;
  views?: number | null;
  shares?: number | null;
  saves?: number | null;
  reposts?: number | null;
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
  avgShares: number;
  avgSaves: number;
  avgReposts: number;
  erFollowers: number;
  erViews: number;
  erTalenthub: number;
  topHashtags: HashtagCount[];
  topMentions: MentionCount[];
}

const HASHTAG_REGEX = /#([a-z0-9_]+)/gi;
const MENTION_REGEX = /@([a-z0-9_.]+)/gi;

export function extractHashtags(caption: string): string[] {
  return Array.from(
    (caption ?? "").matchAll(HASHTAG_REGEX),
    (match) => match[1].toLowerCase()
  );
}

export function extractMentions(caption: string): string[] {
  return Array.from(
    (caption ?? "").matchAll(MENTION_REGEX),
    (match) => match[1].toLowerCase()
  );
}

function topN<T extends string>(
  values: T[],
  limit: number
): { key: T; count: number }[] {
  const counts = new Map<T, number>();

  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

export function filterPostsByRange<T extends RawPostLike>(
  posts: T[],
  days: number
): T[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  return posts.filter((post) => {
    const postedTime = new Date(post.postedAt).getTime();
    return !Number.isNaN(postedTime) && postedTime >= cutoff;
  });
}

function safeMetric(value: number | null | undefined): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    return 0;
  }

  return value;
}

function averageOf(
  posts: RawPostLike[],
  pick: (post: RawPostLike) => number | null | undefined
): number {
  if (posts.length === 0) return 0;

  const sum = posts.reduce(
    (total, post) => total + safeMetric(pick(post)),
    0
  );

  return sum / posts.length;
}

export function computeInsightsFromPosts(
  posts: RawPostLike[],
  followers: number,
  totalPostFallback: number,
  hashtagLimit = 10,
  mentionLimit = 5
): ProfileInsights {
  const postCount = posts.length;

  if (postCount === 0) {
    return {
      totalPosts: totalPostFallback,
      avgLikes: 0,
      avgComments: 0,
      avgViews: 0,
      avgShares: 0,
      avgSaves: 0,
      avgReposts: 0,
      erFollowers: 0,
      erViews: 0,
      erTalenthub: 0,
      topHashtags: [],
      topMentions: [],
    };
  }

  // Semua postingan pada periode terpilih digunakan.
  const avgLikes = averageOf(posts, (post) => post.likes);
  const avgComments = averageOf(posts, (post) => post.comments);
  const avgShares = averageOf(posts, (post) => post.shares);
  const avgSaves = averageOf(posts, (post) => post.saves);
  const avgReposts = averageOf(posts, (post) => post.reposts);

  // Khusus ER TalentHub: semua post menjadi penyebut.
  // Foto/carousel tanpa views tetap ikut dengan nilai views = 0.
  const avgViewsAllPosts = averageOf(posts, (post) => post.views);

  // Khusus Average Views tampilan dan ER by Views:
  // hanya post yang benar-benar mempunyai views.
  const viewPosts = posts.filter(
    (post) => safeMetric(post.views) > 0
  );

  const avgViewsForViewPosts = averageOf(
    viewPosts,
    (post) => post.views
  );
  const avgLikesView = averageOf(viewPosts, (post) => post.likes);
  const avgCommentsView = averageOf(
    viewPosts,
    (post) => post.comments
  );
  const avgSharesView = averageOf(viewPosts, (post) => post.shares);
  const avgSavesView = averageOf(viewPosts, (post) => post.saves);
  const avgRepostsView = averageOf(
    viewPosts,
    (post) => post.reposts
  );

  // ER by Followers:
  // (avg likes + comments + shares + saves + reposts) / followers * 100
  const engagementAverageAllPosts =
    avgLikes + avgComments + avgShares + avgSaves + avgReposts;

  const erFollowers =
    followers > 0
      ? (engagementAverageAllPosts / followers) * 100
      : 0;

  // ER by Views memakai subset yang sama pada pembilang dan penyebut.
  const engagementAverageViewPosts =
    avgLikesView +
    avgCommentsView +
    avgSharesView +
    avgSavesView +
    avgRepostsView;

  const erViews =
    avgViewsForViewPosts > 0
      ? (engagementAverageViewPosts / avgViewsForViewPosts) * 100
      : 0;

  // ER by TalentHub:
  // (avg likes + comments + shares + saves + views + reposts) / followers
  // Tidak dikalikan 100 dan seluruh post ikut dihitung.
  const talenthubAverageAllPosts =
    avgLikes +
    avgComments +
    avgShares +
    avgSaves +
    avgViewsAllPosts +
    avgReposts;

  const erTalenthub =
    followers > 0 ? talenthubAverageAllPosts / followers : 0;

  const allHashtags = posts.flatMap((post) =>
    extractHashtags(post.caption ?? "")
  );
  const allMentions = posts.flatMap((post) =>
    extractMentions(post.caption ?? "")
  );

  const topHashtags = topN(allHashtags, hashtagLimit).map(
    ({ key, count }) => ({ tag: key, count })
  );
  const topMentions = topN(allMentions, mentionLimit).map(
    ({ key, count }) => ({ mention: key, count })
  );

  return {
    totalPosts: postCount,
    avgLikes: Math.round(avgLikes),
    avgComments: Math.round(avgComments),
    // Nilai kartu Average Views tetap hanya dari post dengan views.
    avgViews: Math.round(avgViewsForViewPosts),
    avgShares: Math.round(avgShares),
    avgSaves: Math.round(avgSaves),
    avgReposts: Math.round(avgReposts),
    erFollowers: Number(erFollowers.toFixed(2)),
    erViews: Number(erViews.toFixed(2)),
    erTalenthub: Number(erTalenthub.toFixed(2)),
    topHashtags,
    topMentions,
  };
}

export function computeProfileInsights(
  profile: {
    followers: number;
    totalPost: number;
    posts: RawPostLike[];
  },
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

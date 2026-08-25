// Pure, dependency-free helpers for turning scraped posts
// into profile insights.

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

/**
 * Mengambil hashtag dari caption.
 */
export function extractHashtags(caption: string): string[] {
  const matches = (caption ?? "").matchAll(HASHTAG_REGEX);

  return Array.from(
    matches,
    (match) => match[1].toLowerCase()
  );
}

/**
 * Mengambil mention dari caption.
 */
export function extractMentions(caption: string): string[] {
  const matches = (caption ?? "").matchAll(MENTION_REGEX);

  return Array.from(
    matches,
    (match) => match[1].toLowerCase()
  );
}

/**
 * Mengambil nilai yang paling sering muncul.
 */
function topN<T extends string>(
  values: T[],
  limit: number
): { key: T; count: number }[] {
  const counts = new Map<T, number>();

  for (const value of values) {
    counts.set(
      value,
      (counts.get(value) ?? 0) + 1
    );
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({
      key,
      count,
    }));
}

/**
 * Memfilter post berdasarkan jumlah hari terakhir.
 *
 * Contoh:
 * - 7  = H-7
 * - 30 = H-30
 * - 60 = H-60
 * - 90 = H-90
 */
export function filterPostsByRange<T extends RawPostLike>(
  posts: T[],
  days: number
): T[] {
  const cutoff =
    Date.now() - days * 24 * 60 * 60 * 1000;

  return posts.filter((post) => {
    const postedTime =
      new Date(post.postedAt).getTime();

    return (
      !Number.isNaN(postedTime) &&
      postedTime >= cutoff
    );
  });
}

/**
 * Mengubah metrik yang tidak valid menjadi 0.
 *
 * Instagram dapat mengembalikan -1 ketika
 * jumlah likes disembunyikan.
 */
function safeMetric(
  value: number | null | undefined
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    return 0;
  }

  return value;
}

/**
 * Menghitung rata-rata satu metrik
 * dari kumpulan post tertentu.
 */
function averageOf(
  posts: RawPostLike[],
  pick: (
    post: RawPostLike
  ) => number | null | undefined
): number {
  if (posts.length === 0) {
    return 0;
  }

  const total = posts.reduce(
    (sum, post) =>
      sum + safeMetric(pick(post)),
    0
  );

  return total / posts.length;
}

/**
 * Menghitung seluruh insight creator.
 */
export function computeInsightsFromPosts(
  posts: RawPostLike[],
  followers: number,
  totalPostFallback: number,
  hashtagLimit = 10,
  mentionLimit = 5
): ProfileInsights {
  const postCount = posts.length;

  /*
   * ========================================
   * RATA-RATA DARI SELURUH POST
   * ========================================
   *
   * Digunakan untuk:
   * - Average Likes
   * - Average Comments
   * - Average Shares
   * - Average Saves
   * - Average Reposts
   * - ER Followers
   * - ER TalentHub
   */

  const avgLikes = averageOf(
    posts,
    (post) => post.likes
  );

  const avgComments = averageOf(
    posts,
    (post) => post.comments
  );

  const avgShares = averageOf(
    posts,
    (post) => post.shares
  );

  const avgSaves = averageOf(
    posts,
    (post) => post.saves
  );

  const avgReposts = averageOf(
    posts,
    (post) => post.reposts
  );

  /*
   * ========================================
   * POST YANG MEMILIKI VIEWS
   * ========================================
   *
   * Jika terdapat 21 post, tetapi hanya
   * 3 post yang memiliki views, seluruh
   * komponen ER Views dihitung dari 3 post.
   */

  const viewPosts = posts.filter(
    (post) => safeMetric(post.views) > 0
  );

  /*
   * Average Views hanya dibagi dengan jumlah
   * post yang benar-benar mempunyai views.
   */

  const avgViews = averageOf(
    viewPosts,
    (post) => post.views
  );

  /*
   * Engagement khusus post yang mempunyai views.
   */

  const avgLikesView = averageOf(
    viewPosts,
    (post) => post.likes
  );

  const avgCommentsView = averageOf(
    viewPosts,
    (post) => post.comments
  );

  const avgSharesView = averageOf(
    viewPosts,
    (post) => post.shares
  );

  const avgSavesView = averageOf(
    viewPosts,
    (post) => post.saves
  );

  const avgRepostsView = averageOf(
    viewPosts,
    (post) => post.reposts
  );

  /*
   * ========================================
   * ER BY FOLLOWERS
   * ========================================
   *
   * Formula:
   *
   * (
   *   avg likes
   *   + avg comments
   *   + avg shares
   *   + avg saves
   *   + avg reposts
   * )
   * ÷ followers
   * × 100
   *
   * Semua post dalam periode digunakan.
   */

  const engagementAverageAllPosts =
    avgLikes +
    avgComments +
    avgShares +
    avgSaves +
    avgReposts;

  const erFollowers =
    followers > 0
      ? (
          engagementAverageAllPosts /
          followers
        ) * 100
      : 0;

  /*
   * ========================================
   * ER BY VIEWS
   * ========================================
   *
   * Formula:
   *
   * (
   *   avg likes video
   *   + avg comments video
   *   + avg shares video
   *   + avg saves video
   *   + avg reposts video
   * )
   * ÷ avg views video
   * × 100
   *
   * Pembilang dan penyebut menggunakan
   * post yang sama, yaitu viewPosts.
   */

  const engagementAverageViewPosts =
    avgLikesView +
    avgCommentsView +
    avgSharesView +
    avgSavesView +
    avgRepostsView;

  const erViews =
    avgViews > 0
      ? (
          engagementAverageViewPosts /
          avgViews
        ) * 100
      : 0;

  /*
   * ========================================
   * ER BY TALENTHUB
   * ========================================
   *
   * Formula:
   *
   * (
   *   avg likes seluruh post
   *   + avg comments seluruh post
   *   + avg shares seluruh post
   *   + avg saves seluruh post
   *   + avg views dari post yang punya views
   *   + avg reposts seluruh post
   * )
   * ÷ followers
   *
   * Tidak dikalikan 100.
   */

  const talenthubAverage =
    avgLikes +
    avgComments +
    avgShares +
    avgSaves +
    avgViews +
    avgReposts;

  const erTalenthub =
    followers > 0
      ? talenthubAverage / followers
      : 0;

  /*
   * ========================================
   * HASHTAG DAN MENTION
   * ========================================
   */

  const allHashtags = posts.flatMap(
    (post) => extractHashtags(post.caption)
  );

  const allMentions = posts.flatMap(
    (post) => extractMentions(post.caption)
  );

  const topHashtags = topN(
    allHashtags,
    hashtagLimit
  ).map(({ key, count }) => ({
    tag: key,
    count,
  }));

  const topMentions = topN(
    allMentions,
    mentionLimit
  ).map(({ key, count }) => ({
    mention: key,
    count,
  }));

  /*
   * ========================================
   * HASIL AKHIR
   * ========================================
   */

  return {
    totalPosts:
      postCount > 0
        ? postCount
        : totalPostFallback,

    avgLikes: Math.round(avgLikes),
    avgComments: Math.round(avgComments),
    avgViews: Math.round(avgViews),
    avgShares: Math.round(avgShares),
    avgSaves: Math.round(avgSaves),
    avgReposts: Math.round(avgReposts),

    erFollowers: Number(
      erFollowers.toFixed(2)
    ),

    erViews: Number(
      erViews.toFixed(2)
    ),

    erTalenthub: Number(
      erTalenthub.toFixed(2)
    ),

    topHashtags,
    topMentions,
  };
}

/**
 * Wrapper untuk menghitung insight langsung
 * dari objek profile.
 */
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
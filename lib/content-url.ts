import { normalizePlatform, type SocialPlatform } from "./social-platform";

const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "igsh", "igshid", "si", "share_app_id", "share_item_id",
  "source", "feature", "app", "app_name",
]);

export type ContentIdentity = {
  platform: SocialPlatform;
  normalizedUrl: string;
  contentId: string | null;
  isShortUrl: boolean;
};

export function detectContentPlatform(value: string): SocialPlatform {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("URL content is invalid");
  }
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  if (hostname === "instagram.com" || hostname.endsWith(".instagram.com")) return "instagram";
  if (hostname === "tiktok.com" || hostname.endsWith(".tiktok.com")) return "tiktok";
  if (hostname === "youtube.com" || hostname.endsWith(".youtube.com") || hostname === "youtu.be") return "youtube";
  if (hostname === "x.com" || hostname.endsWith(".x.com") || hostname === "twitter.com" || hostname.endsWith(".twitter.com")) return "twitter";
  throw new Error("Supported content URLs: Instagram, TikTok, YouTube, and Twitter/X");
}

export function normalizeContentUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("URL content is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL content must use HTTP or HTTPS");
  url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/{2,}/g, "/");
  if (url.pathname !== "/") url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url.toString();
}

export function getContentIdentity(value: string, expectedPlatform?: string | null): ContentIdentity {
  const normalizedUrl = normalizeContentUrl(value);
  const url = new URL(normalizedUrl);
  const platform = detectContentPlatform(normalizedUrl);
  const expected = normalizePlatform(expectedPlatform);
  if (expected && expected !== platform) {
    throw new Error(`Expected ${expected} content URL, but a ${platform} URL was provided`);
  }

  const path = url.pathname.split("/").filter(Boolean);
  let contentId: string | null = null;
  let isShortUrl = false;
  if (platform === "instagram") {
    if (!["p", "reel", "reels"].includes(path[0] ?? "") || !path[1]) {
      throw new Error("Expected Instagram post/reel URL, but a profile or unsupported URL was provided");
    }
    contentId = path[1];
  } else if (platform === "tiktok") {
    isShortUrl = ["vm.tiktok.com", "vt.tiktok.com"].includes(url.hostname);
    if (!isShortUrl) {
      const videoIndex = path.indexOf("video");
      if (videoIndex < 0 || !/^\d+$/.test(path[videoIndex + 1] ?? "")) {
        throw new Error("Expected TikTok video URL, but a profile or unsupported URL was provided");
      }
      contentId = path[videoIndex + 1];
    }
  } else if (platform === "youtube") {
    contentId = url.hostname === "youtu.be"
      ? path[0] ?? null
      : path[0] === "shorts" || path[0] === "live"
        ? path[1] ?? null
        : url.searchParams.get("v");
    if (!contentId) throw new Error("Expected YouTube video/Short URL, but a channel or unsupported URL was provided");
  } else {
    const statusIndex = path.indexOf("status");
    contentId = statusIndex >= 0 ? path[statusIndex + 1] ?? null : null;
    if (!contentId) throw new Error("Expected Twitter/X post URL, but a profile or unsupported URL was provided");
  }
  return { platform, normalizedUrl, contentId, isShortUrl };
}

export function contentIdentityMatches(requested: ContentIdentity, returned: ContentIdentity): boolean {
  if (requested.platform !== returned.platform) return false;
  if (requested.contentId && returned.contentId) return requested.contentId === returned.contentId;
  return requested.normalizedUrl === returned.normalizedUrl;
}

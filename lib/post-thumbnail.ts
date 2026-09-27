import { createHash } from "node:crypto";
import { put } from "@vercel/blob";

type Platform = "instagram" | "tiktok";

export type PostWithThumbnail = {
  postUrl: string;
  thumbnailUrl?: string;
};

type PersistOptions = {
  username: string;
  platform: Platform;
  existingThumbnailByPostUrl?: Map<string, string>;
  concurrency?: number;
};

const MAX_IMAGE_SIZE = 8 * 1024 * 1024;

function sanitizePath(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function isVercelBlobUrl(value?: string | null): boolean {
  if (!value) return false;

  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      url.hostname.endsWith(".blob.vercel-storage.com")
    );
  } catch {
    return false;
  }
}

function getPostId(
  postUrl: string,
  platform: Platform
): string {
  try {
    const url = new URL(postUrl);
    const path = url.pathname
      .split("/")
      .filter(Boolean);

    if (platform === "instagram") {
      if (
        ["p", "reel", "reels"].includes(
          path[0] ?? ""
        ) &&
        path[1]
      ) {
        return sanitizePath(path[1]);
      }
    }

    if (platform === "tiktok") {
      const videoIndex = path.indexOf("video");
      const videoId = path[videoIndex + 1];

      if (
        videoIndex >= 0 &&
        /^\d+$/.test(videoId ?? "")
      ) {
        return videoId;
      }
    }
  } catch {
    // Gunakan hash sebagai fallback.
  }

  return createHash("sha256")
    .update(postUrl)
    .digest("hex")
    .slice(0, 24);
}

function extensionFromContentType(
  contentType: string
): string {
  const normalized = contentType
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (normalized === "image/png") return "png";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/avif") return "avif";

  return "jpg";
}

async function uploadThumbnail(
  temporaryUrl: string,
  options: {
    username: string;
    platform: Platform;
    postUrl: string;
  }
): Promise<string | null> {
  if (isVercelBlobUrl(temporaryUrl)) {
    return temporaryUrl;
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(temporaryUrl);
  } catch {
    return null;
  }

  if (
    parsedUrl.protocol !== "https:" &&
    parsedUrl.protocol !== "http:"
  ) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    30_000
  );

  try {
    const response = await fetch(temporaryUrl, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "image/avif,image/webp,image/png,image/jpeg,*/*",
        "User-Agent":
          "Mozilla/5.0 (compatible; TalentHubThumbnailBot/1.0)",
      },
    });

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText}`
      );
    }

    const contentType =
      response.headers.get("content-type") ??
      "image/jpeg";

    if (!contentType.toLowerCase().startsWith("image/")) {
      throw new Error(
        `Response bukan gambar: ${contentType}`
      );
    }

    const contentLength = Number(
      response.headers.get("content-length") ?? 0
    );

    if (
      contentLength > 0 &&
      contentLength > MAX_IMAGE_SIZE
    ) {
      throw new Error(
        `Ukuran gambar terlalu besar: ${contentLength} bytes`
      );
    }

    const arrayBuffer = await response.arrayBuffer();

    if (arrayBuffer.byteLength === 0) {
      throw new Error("File gambar kosong");
    }

    if (arrayBuffer.byteLength > MAX_IMAGE_SIZE) {
      throw new Error(
        `Ukuran gambar terlalu besar: ${arrayBuffer.byteLength} bytes`
      );
    }

    const postId = getPostId(
      options.postUrl,
      options.platform
    );

    const extension =
      extensionFromContentType(contentType);

    const pathname = [
      "post-thumbnails",
      options.platform,
      sanitizePath(options.username),
      `${postId}.${extension}`,
    ].join("/");

    const blob = await put(pathname, arrayBuffer, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType,
      cacheControlMaxAge: 31_536_000,
    });

    return blob.url;
  } catch (error) {
    console.error(
      `[THUMBNAIL] Gagal upload ${options.postUrl}:`,
      error
    );

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function persistPostThumbnails<
  T extends PostWithThumbnail
>(
  posts: T[],
  options: PersistOptions
): Promise<T[]> {
  const results: T[] = new Array(posts.length);
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency ?? 3, 5)
  );

  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;

      if (index >= posts.length) {
        return;
      }

      const post = posts[index];
      const temporaryUrl =
        post.thumbnailUrl?.trim();

      let permanentUrl: string | null = null;

      if (temporaryUrl) {
        permanentUrl = await uploadThumbnail(
          temporaryUrl,
          {
            username: options.username,
            platform: options.platform,
            postUrl: post.postUrl,
          }
        );
      }

      const existingUrl =
        options.existingThumbnailByPostUrl?.get(
          post.postUrl
        );

      // Jika upload gagal, gunakan thumbnail Blob lama
      // apabila postingannya sudah pernah tersimpan.
      const fallbackUrl =
        existingUrl &&
        isVercelBlobUrl(existingUrl)
          ? existingUrl
          : undefined;

      results[index] = {
        ...post,
        // Jangan simpan kembali URL CDN sementara.
        thumbnailUrl:
          permanentUrl ??
          fallbackUrl ??
          undefined,
      };
    }
  }

  await Promise.all(
    Array.from(
      {
        length: Math.min(
          concurrency,
          posts.length
        ),
      },
      () => worker()
    )
  );

  const uploadedCount = results.filter(
    (post) =>
      post?.thumbnailUrl &&
      isVercelBlobUrl(post.thumbnailUrl)
  ).length;

  console.log(
    `[THUMBNAIL] ${uploadedCount}/${posts.length} thumbnail menggunakan Blob`
  );

  return results;
}
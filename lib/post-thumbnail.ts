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
const DOWNLOAD_TIMEOUT_MS = 60_000;
const MAX_UPLOAD_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3_000;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function sanitizePath(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

function isVercelBlobUrl(
  value?: string | null
): boolean {
  if (!value) return false;

  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      (
        url.hostname ===
          "blob.vercel-storage.com" ||
        url.hostname.endsWith(
          ".blob.vercel-storage.com"
        )
      )
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
      const videoIndex =
        path.indexOf("video");

      const videoId =
        path[videoIndex + 1];

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

  if (normalized === "image/png") {
    return "png";
  }

  if (normalized === "image/webp") {
    return "webp";
  }

  if (normalized === "image/gif") {
    return "gif";
  }

  if (normalized === "image/avif") {
    return "avif";
  }

  return "jpg";
}

function refererForPlatform(
  platform: Platform
): string {
  if (platform === "tiktok") {
    return "https://www.tiktok.com/";
  }

  return "https://www.instagram.com/";
}

/**
 * Satu kali percobaan download dan upload.
 *
 * Error dilempar ke fungsi retry agar percobaan
 * berikutnya dapat dijalankan.
 */
async function uploadThumbnailOnce(
  temporaryUrl: string,
  options: {
    username: string;
    platform: Platform;
    postUrl: string;
  }
): Promise<string> {
  if (isVercelBlobUrl(temporaryUrl)) {
    return temporaryUrl;
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(temporaryUrl);
  } catch {
    throw new Error(
      "URL thumbnail tidak valid"
    );
  }

  if (
    parsedUrl.protocol !== "https:" &&
    parsedUrl.protocol !== "http:"
  ) {
    throw new Error(
      "URL thumbnail harus menggunakan HTTP/HTTPS"
    );
  }

  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    DOWNLOAD_TIMEOUT_MS
  );

  try {
    const response = await fetch(
      temporaryUrl,
      {
        redirect: "follow",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          Accept:
            "image/avif,image/webp,image/apng," +
            "image/svg+xml,image/*,*/*;q=0.8",

          Referer: refererForPlatform(
            options.platform
          ),

          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/131.0.0.0 Safari/537.36",
        },
      }
    );

    if (!response.ok) {
      throw new Error(
        `Download HTTP ${response.status} ` +
          `${response.statusText}`
      );
    }

    const contentType =
      response.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase() ??
      "image/jpeg";

    if (
      !contentType.startsWith("image/")
    ) {
      throw new Error(
        `Response bukan gambar: ${contentType}`
      );
    }

    const contentLength = Number(
      response.headers.get(
        "content-length"
      ) ?? 0
    );

    if (
      contentLength > 0 &&
      contentLength > MAX_IMAGE_SIZE
    ) {
      throw new Error(
        `Ukuran gambar terlalu besar: ` +
          `${contentLength} bytes`
      );
    }

    const arrayBuffer =
      await response.arrayBuffer();

    if (arrayBuffer.byteLength === 0) {
      throw new Error(
        "File gambar kosong"
      );
    }

    if (
      arrayBuffer.byteLength >
      MAX_IMAGE_SIZE
    ) {
      throw new Error(
        `Ukuran gambar terlalu besar: ` +
          `${arrayBuffer.byteLength} bytes`
      );
    }

    const postId = getPostId(
      options.postUrl,
      options.platform
    );

    const extension =
      extensionFromContentType(
        contentType
      );

    const pathname = [
      "post-thumbnails",
      options.platform,
      sanitizePath(options.username),
      `${postId}.${extension}`,
    ].join("/");

    const blob = await put(
      pathname,
      arrayBuffer,
      {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType,
        cacheControlMaxAge: 31_536_000,
      }
    );

    return blob.url;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Maksimal tiga percobaan untuk satu thumbnail.
 *
 * Hanya thumbnail yang gagal yang akan diulang.
 */
async function uploadThumbnailWithRetry(
  temporaryUrl: string,
  options: {
    username: string;
    platform: Platform;
    postUrl: string;
  }
): Promise<string | null> {
  let lastError: unknown;

  for (
    let attempt = 1;
    attempt <= MAX_UPLOAD_ATTEMPTS;
    attempt++
  ) {
    try {
      const blobUrl =
        await uploadThumbnailOnce(
          temporaryUrl,
          options
        );

      if (attempt > 1) {
        console.log(
          `[THUMBNAIL] Berhasil pada percobaan ` +
            `${attempt}/${MAX_UPLOAD_ATTEMPTS}: ` +
            `${options.postUrl}`
        );
      }

      return blobUrl;
    } catch (error) {
      lastError = error;

      const message =
        error instanceof Error
          ? error.message
          : String(error);

      console.warn(
        `[THUMBNAIL] Percobaan ` +
          `${attempt}/${MAX_UPLOAD_ATTEMPTS} gagal ` +
          `${options.postUrl}: ${message}`
      );

      if (
        attempt <
        MAX_UPLOAD_ATTEMPTS
      ) {
        const delay =
          RETRY_DELAY_MS * attempt;

        console.log(
          `[THUMBNAIL] Ulangi dalam ` +
            `${delay / 1000} detik: ` +
            `${options.postUrl}`
        );

        await sleep(delay);
      }
    }
  }

  console.error(
    `[THUMBNAIL] Gagal permanen setelah ` +
      `${MAX_UPLOAD_ATTEMPTS} percobaan: ` +
      `${options.postUrl}`,
    lastError
  );

  return null;
}

export async function persistPostThumbnails<
  T extends PostWithThumbnail
>(
  posts: T[],
  options: PersistOptions
): Promise<T[]> {
  const results: T[] =
    new Array(posts.length);

  /*
   * Default satu koneksi agar CDN Instagram
   * tidak menerima banyak download bersamaan.
   *
   * Maksimal tetap dibatasi dua apabila caller
   * secara eksplisit mengirim nilai lebih besar.
   */
  const concurrency = Math.max(
    1,
    Math.min(
      options.concurrency ?? 1,
      2
    )
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

      const existingUrl =
        options
          .existingThumbnailByPostUrl
          ?.get(post.postUrl);

      const fallbackUrl =
        existingUrl &&
        isVercelBlobUrl(existingUrl)
          ? existingUrl
          : undefined;

      let permanentUrl:
        | string
        | null = null;

      /*
       * URL yang sudah Blob tidak perlu
       * di-download atau di-upload ulang.
       */
      if (
        temporaryUrl &&
        isVercelBlobUrl(temporaryUrl)
      ) {
        permanentUrl = temporaryUrl;
      } else if (temporaryUrl) {
        permanentUrl =
          await uploadThumbnailWithRetry(
            temporaryUrl,
            {
              username:
                options.username,
              platform:
                options.platform,
              postUrl:
                post.postUrl,
            }
          );
      } else {
        console.warn(
          `[THUMBNAIL] URL sumber kosong: ` +
            `${post.postUrl}`
        );
      }

      results[index] = {
        ...post,

        /*
         * Prioritas:
         * 1. Hasil Blob terbaru.
         * 2. Blob lama post yang sama.
         * 3. undefined → disimpan NULL.
         */
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

  const blobCount = results.filter(
    (post) =>
      post?.thumbnailUrl &&
      isVercelBlobUrl(
        post.thumbnailUrl
      )
  ).length;

  const nullCount = results.filter(
    (post) =>
      !String(
        post?.thumbnailUrl ?? ""
      ).trim()
  ).length;

  console.log(
    `[THUMBNAIL] ${blobCount}/${posts.length} ` +
      `thumbnail menggunakan Blob; ` +
      `${nullCount} thumbnail NULL`
  );

  return results;
}
import { put } from "@vercel/blob";

const MAX_PROFILE_IMAGE_BYTES = 5_000_000;
const DOWNLOAD_TIMEOUT_MS = 20_000;

export type ProfileImagePlatform = "instagram" | "tiktok";

export interface PersistProfileImageOptions {
  username: string;
  platform: ProfileImagePlatform;
}

export function firstProfileImageUrl(
  sourceUrls: Array<string | null | undefined>
): string | null {
  for (const value of sourceUrls) {
    const candidate = String(value ?? "").trim();
    if (!candidate) continue;

    try {
      const parsed = new URL(candidate);

      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        return candidate;
      }
    } catch {
      // Abaikan URL rusak dan lanjut ke kandidat berikutnya.
    }
  }

  return null;
}

function isVercelBlobUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLowerCase();

    return (
      hostname === "blob.vercel-storage.com" ||
      hostname.endsWith(".blob.vercel-storage.com")
    );
  } catch {
    return false;
  }
}

function safePathPart(value: string): string {
  const normalized = value
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^[_\.]+|[_\.]+$/g, "");

  return normalized || "unknown";
}

function refererFor(url: URL): string {
  const hostname = url.hostname.toLowerCase();

  if (hostname.includes("tiktok") || hostname.includes("byteoversea")) {
    return "https://www.tiktok.com/";
  }

  return "https://www.instagram.com/";
}

/**
 * Download foto sementara dari Instagram/TikTok lalu simpan ke Vercel Blob.
 *
 * Return null berarti upload gagal. Pemanggil harus mempertahankan photo_url
 * lama dan tidak menyimpan kembali URL CDN sementara.
 */
export async function persistProfileImage(
  sourceUrl: string | null | undefined,
  options: PersistProfileImageOptions
): Promise<string | null> {
  const value = String(sourceUrl ?? "").trim();

  if (!value) return null;
  if (isVercelBlobUrl(value)) return value;

  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();

  if (!token) {
    console.warn(
      `[PHOTO] BLOB_READ_WRITE_TOKEN belum diatur. Foto ${options.username} tidak di-upload.`
    );
    return null;
  }

  let source: URL;

  try {
    source = new URL(value);

    if (source.protocol !== "https:" && source.protocol !== "http:") {
      return null;
    }
  } catch {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(source, {
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        Referer: refererFor(source),
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 Chrome/131 Safari/537.36",
      },
    });

    if (!response.ok) {
      throw new Error(`download HTTP ${response.status}`);
    }

    const contentType = response.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase();

    if (!contentType?.startsWith("image/")) {
      throw new Error(`response bukan gambar: ${contentType ?? "unknown"}`);
    }

    const contentLength = Number(response.headers.get("content-length") ?? 0);

    if (contentLength > MAX_PROFILE_IMAGE_BYTES) {
      throw new Error(`gambar terlalu besar: ${contentLength} bytes`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());

    if (!bytes.length || bytes.length > MAX_PROFILE_IMAGE_BYTES) {
      throw new Error(`ukuran gambar tidak valid: ${bytes.length} bytes`);
    }

    const pathname = [
      "profile-images",
      safePathPart(options.platform),
      safePathPart(options.username),
    ].join("/");

    const blob = await put(pathname, bytes, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType,
      token,
    });

    console.log(`[PHOTO] ${options.username} tersimpan: ${blob.url}`);

    return blob.url;
  } catch (error) {
    console.error(`[PHOTO] Gagal menyimpan foto ${options.username}:`, error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function persistFirstProfileImage(
  sourceUrls: Array<string | null | undefined>,
  options: PersistProfileImageOptions
): Promise<string | null> {
  const candidates = [
    ...new Set(
      sourceUrls
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    ),
  ];

  for (const candidate of candidates) {
    const persisted = await persistProfileImage(candidate, options);

    if (persisted) return persisted;
  }

  return null;
}


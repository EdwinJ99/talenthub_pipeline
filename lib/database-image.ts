import sharp from "sharp";
import { setDefaultResultOrder } from "node:dns";

// VPS/Docker kadang menerima alamat IPv6 CDN yang tidak memiliki rute stabil.
// Dahulukan IPv4, tetapi tetap izinkan Node memakai IPv6 sebagai fallback.
setDefaultResultOrder("ipv4first");

export type ImagePlatform = "instagram" | "tiktok";
export type ImageKind = "profile" | "thumbnail";

export type DownloadedImage = {
  data: Uint8Array<ArrayBuffer>;
  mimeType: string;
  sizeBytes: number;
};

function copyToArrayBufferBytes(
  value: Uint8Array
): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

type DownloadOptions = {
  platform: ImagePlatform;
  kind: ImageKind;
  label: string;
  attempts?: number;
};

const DOWNLOAD_TIMEOUT_MS = 60_000;
const RETRY_DELAYS_MS = [5_000, 15_000] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt: number): number {
  const baseDelay =
    RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)] ??
    15_000;
  const jitter = Math.floor(Math.random() * 3_000);

  return baseDelay + jitter;
}

function sourceHost(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "invalid-url";
  }
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & {
    cause?: { code?: string; message?: string };
  }).cause;
  return [error.message, cause?.code, cause?.message].filter(Boolean).join(" | ");
}

function referer(platform: ImagePlatform): string {
  return platform === "tiktok"
    ? "https://www.tiktok.com/"
    : "https://www.instagram.com/";
}

function validateRemoteUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("URL gambar harus HTTP/HTTPS");
  }

  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^10\./.test(host) ||
    /^127\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new Error("Host gambar lokal/private tidak diizinkan");
  }
  return url;
}

async function optimizeImage(
  original: Buffer,
  originalMimeType: string,
  kind: ImageKind
): Promise<DownloadedImage> {
  try {
    let image = sharp(original, {
      failOn: "none",
      limitInputPixels: false,
    }).rotate();

    image =
      kind === "profile"
        ? image.resize(320, 320, {
            fit: "cover",
            withoutEnlargement: true,
          })
        : image.resize({
            width: 960,
            height: 960,
            fit: "inside",
            withoutEnlargement: true,
          });

    const webp = await image
      .webp({ quality: 78, effort: 4 })
      .toBuffer();

    return {
      data: copyToArrayBufferBytes(webp),
      mimeType: "image/webp",
      sizeBytes: webp.byteLength,
    };
  } catch (error) {
    console.warn(
      "[MEDIA] Optimasi gagal; file asli digunakan:",
      errorMessage(error)
    );
    return {
      data: copyToArrayBufferBytes(original),
      mimeType: originalMimeType || "application/octet-stream",
      sizeBytes: original.byteLength,
    };
  }
}

async function downloadOnce(
  sourceUrl: string,
  options: DownloadOptions
): Promise<DownloadedImage> {
  validateRemoteUrl(sourceUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(sourceUrl, {
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept:
          "image/avif,image/webp,image/apng,image/png,image/jpeg,image/*,*/*;q=0.8",
        Referer: referer(options.platform),
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
          "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36",
      },
    });

    if (!response.ok) {
      throw new Error(`download HTTP ${response.status} ${response.statusText}`);
    }

    const mimeType = String(response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();

    if (!mimeType.startsWith("image/")) {
      throw new Error(`response bukan gambar: ${mimeType || "unknown"}`);
    }

    // Tidak ada batas ukuran file. Jika optimasi gagal, file asli tetap disimpan.
    const original = Buffer.from(await response.arrayBuffer());
    if (!original.length) throw new Error("File gambar kosong");

    return optimizeImage(original, mimeType, options.kind);
  } finally {
    clearTimeout(timeout);
  }
}

export async function downloadImageWithRetry(
  sourceUrls: Array<string | null | undefined>,
  options: DownloadOptions
): Promise<DownloadedImage | null> {
  const candidates = [
    ...new Set(
      sourceUrls.map((value) => String(value ?? "").trim()).filter(Boolean)
    ),
  ];
  const attempts = Math.max(1, options.attempts ?? 3);

  for (const candidate of candidates) {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const image = await downloadOnce(candidate, options);
        console.log(
          `[MEDIA] ${options.label} berhasil (${image.sizeBytes} bytes), ` +
            `percobaan ${attempt}/${attempts}`
        );
        return image;
      } catch (error) {
        lastError = error;
        console.warn(
          `[MEDIA] ${options.label} gagal ${attempt}/${attempts}: ` +
            `${errorMessage(error)} | host=${sourceHost(candidate)}`
        );
        if (attempt < attempts) {
          const waitMs = retryDelay(attempt);
          console.log(
            `[MEDIA] ${options.label} diulang dalam ` +
              `${Math.ceil(waitMs / 1_000)} detik`
          );
          await sleep(waitMs);
        }
      }
    }
    console.error(`[MEDIA] Kandidat gagal untuk ${options.label}`, lastError);
  }

  return null;
}

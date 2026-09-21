import "dotenv/config";

import {
  processCreator,
  prisma,
  type SeedEntry,
} from "../lib/pipeline";

const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 5000;
const REFRESH_AFTER_DAYS = 7;

/**
 * null = proses semua creator yang memenuhi syarat.
 * Isi angka, misalnya 50, untuk membatasi satu kali eksekusi.
 */
const CREATOR_LIMIT: number | null = null;

class GlobalPipelineError extends Error {
  readonly originalError: unknown;

  constructor(
    message: string,
    originalError: unknown
  ) {
    super(message);
    this.name = "GlobalPipelineError";
    this.originalError = originalError;
  }
}

async function sleep(
  milliseconds: number
): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function normalizeUsername(
  value: string | null | undefined
): string {
  return String(value ?? "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
}

function normalizePlatform(
  value: string | null | undefined
): "instagram" | "tiktok" | null {
  const platform = String(value ?? "")
    .trim()
    .toLowerCase();

  if (
    platform === "instagram" ||
    platform === "ig"
  ) {
    return "instagram";
  }

  if (
    platform === "tiktok" ||
    platform === "tik tok" ||
    platform === "tt"
  ) {
    return "tiktok";
  }

  return null;
}

/**
 * Menggabungkan pesan error dan cause agar error jaringan
 * yang dibungkus TypeError tetap bisa dikenali.
 */
function getErrorMessage(
  error: unknown
): string {
  const messages: string[] = [];
  const visited = new Set<unknown>();

  let current: unknown = error;

  for (
    let depth = 0;
    depth < 5 && current;
    depth++
  ) {
    if (visited.has(current)) {
      break;
    }

    visited.add(current);

    if (current instanceof Error) {
      messages.push(
        current.name,
        current.message
      );

      const errorWithCause =
        current as Error & {
          cause?: unknown;
          code?: unknown;
        };

      if (errorWithCause.code) {
        messages.push(
          String(errorWithCause.code)
        );
      }

      current =
        errorWithCause.cause;
    } else if (
      typeof current === "object"
    ) {
      const objectError =
        current as {
          message?: unknown;
          code?: unknown;
          cause?: unknown;
        };

      if (objectError.message) {
        messages.push(
          String(objectError.message)
        );
      }

      if (objectError.code) {
        messages.push(
          String(objectError.code)
        );
      }

      current =
        objectError.cause;
    } else {
      messages.push(
        String(current)
      );

      break;
    }
  }

  return messages
    .join(" ")
    .toLowerCase();
}

/**
 * Error global bukan kesalahan satu creator.
 *
 * Setelah tiga percobaan pada creator yang sedang berjalan,
 * pipeline dihentikan supaya tidak menghabiskan seluruh
 * antrean ketika internet/database mati atau seluruh token
 * Apify sudah tidak tersedia.
 */
function isGlobalFailure(
  error: unknown
): boolean {
  const message =
    getErrorMessage(error);

  const globalErrorKeywords = [
    // Internet, DNS, dan koneksi keluar
    "fetch failed",
    "eai_again",
    "enotfound",
    "econnrefused",
    "econnreset",
    "enetunreach",
    "etimedout",
    "network is unreachable",
    "socket hang up",

    // Database Neon / Prisma
    "can't reach database server",
    "p1001",
    "connection terminated",
    "connection timeout",
    "server has closed the connection",

    // Seluruh token Apify tidak tersedia
    "no active apify token",
    "no available apify token",
    "no apify token available",
    "no usable apify token",
    "all apify tokens",
    "all tokens are exhausted",
    "token pool exhausted",
    "apify token pool exhausted",
    "semua token apify",
    "quota exceeded for all",
    "monthly usage hard limit",
    "usage limit exceeded",
    "authentication token is not valid",
    "insufficient permissions for the key-value store",
  ];

  return globalErrorKeywords.some(
    (keyword) =>
      message.includes(keyword)
  );
}

/**
 * Mengambil creator yang:
 * 1. Belum pernah di-scrape (last_scraped_at NULL), atau
 * 2. Terakhir di-scrape minimal tujuh hari yang lalu.
 *
 * NULL diprioritaskan, kemudian tanggal scrape paling lama.
 */
async function loadSeedFromDatabase(): Promise<
  SeedEntry[]
> {
  const refreshCutoff = new Date(
    Date.now() -
      REFRESH_AFTER_DAYS *
        24 *
        60 *
        60 *
        1000
  );

  console.log(
    "[DATABASE] Mengambil creator yang belum di-scrape " +
      `atau sudah >= ${REFRESH_AFTER_DAYS} hari...`
  );

  console.log(
    `[DATABASE] Batas refresh: ${refreshCutoff.toISOString()}`
  );

  const creators =
    await prisma.mst_creators.findMany({
      where: {
        OR: [
          {
            last_scraped_at: null,
          },
          {
            last_scraped_at: {
              lte: refreshCutoff,
            },
          },
        ],

        social_media: {
          in: [
            "instagram",
            "Instagram",
            "INSTAGRAM",
            "ig",
            "tiktok",
            "TikTok",
            "TIKTOK",
            "tik tok",
            "tt",
          ],
        },
      },

      select: {
        id: true,
        username: true,
        social_media: true,
        last_scraped_at: true,
      },

      orderBy: [
        {
          last_scraped_at: {
            sort: "asc",
            nulls: "first",
          },
        },
        {
          id: "asc",
        },
      ],

      ...(CREATOR_LIMIT !== null
        ? {
            take: CREATOR_LIMIT,
          }
        : {}),
    });

  const uniqueCreators = new Map<
    string,
    SeedEntry
  >();

  for (const creator of creators) {
    const username = normalizeUsername(
      creator.username
    );

    const platform = normalizePlatform(
      creator.social_media
    );

    if (!username) {
      console.warn(
        `[SKIPPED DATABASE] ID ${creator.id}: username kosong`
      );

      continue;
    }

    if (!platform) {
      console.warn(
        `[SKIPPED DATABASE] ID ${creator.id}: ` +
          `platform tidak didukung (${creator.social_media})`
      );

      continue;
    }

    const uniqueKey =
      `${platform}:${username}`;

    if (uniqueCreators.has(uniqueKey)) {
      console.warn(
        `[SKIPPED DUPLICATE] ${username} (${platform})`
      );

      continue;
    }

    uniqueCreators.set(uniqueKey, {
      username,
      platform,
    });
  }

  const seed = Array.from(
    uniqueCreators.values()
  );

  console.log(
    `[DATABASE] ${creators.length} row ditemukan`
  );

  console.log(
    `[DATABASE] ${seed.length} creator valid akan diproses`
  );

  return seed;
}

/**
 * Memproses satu creator maksimal tiga kali.
 *
 * Error lokal setelah tiga kali dilempar ke loop utama
 * agar dicatat lalu lanjut ke creator berikutnya.
 *
 * Error global juga dicoba maksimal tiga kali. Jika tetap
 * gagal, error dibungkus sebagai GlobalPipelineError agar
 * seluruh pipeline dihentikan.
 */
async function processWithRetry(
  entry: SeedEntry
) {
  let lastError: unknown;
  let lastFailureWasGlobal = false;

  for (
    let attempt = 1;
    attempt <= RETRY_COUNT;
    attempt++
  ) {
    try {
      console.log(
        `[ATTEMPT] ${entry.username} ` +
          `(${entry.platform}) ` +
          `${attempt}/${RETRY_COUNT}`
      );

      return await processCreator(entry);
    } catch (error) {
      lastError = error;
      lastFailureWasGlobal =
        isGlobalFailure(error);

      console.error(
        `[FAILED] ${entry.username} ` +
          `(${entry.platform}) ` +
          `percobaan ${attempt}/${RETRY_COUNT}`,
        error
      );

      if (lastFailureWasGlobal) {
        console.error(
          "  [GLOBAL] Gangguan koneksi/token terdeteksi."
        );
      }

      if (attempt < RETRY_COUNT) {
        console.log(
          `[RETRY] ${entry.username}, ` +
            `menunggu ${RETRY_DELAY_MS / 1000} detik`
        );

        await sleep(
          RETRY_DELAY_MS
        );
      }
    }
  }

  if (lastFailureWasGlobal) {
    throw new GlobalPipelineError(
      "Gangguan global tetap terjadi setelah tiga percobaan.",
      lastError
    );
  }

  throw lastError;
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  const seed =
    await loadSeedFromDatabase();

  const instagramCount = seed.filter(
    (creator) =>
      creator.platform === "instagram"
  ).length;

  const tiktokCount = seed.filter(
    (creator) =>
      creator.platform === "tiktok"
  ).length;

  console.log(`
================================
PIPELINE DATABASE

TOTAL CREATOR : ${seed.length}
INSTAGRAM     : ${instagramCount}
TIKTOK        : ${tiktokCount}
RETRY         : ${RETRY_COUNT} kali
LIMIT         : ${CREATOR_LIMIT ?? "SEMUA"}
FILTER        : NULL atau terakhir scrape >= ${REFRESH_AFTER_DAYS} hari
================================
`);

  if (seed.length === 0) {
    console.log(
      "[SELESAI] Tidak ada creator yang perlu di-scrape."
    );

    return;
  }

  const results = {
    success: 0,
    skipped: 0,
    error: 0,
    unknown: 0,
  };

  let processed = 0;

  for (const entry of seed) {
    processed++;

    console.log(`
================================
PROGRESS ${processed}/${seed.length}

--- START ${entry.username} (${entry.platform}) ---
================================
`);

    try {
      const result =
        await processWithRetry(entry);

      if (result?.status === "success") {
        results.success++;

        console.log(
          `[SUCCESS] ${entry.username} ` +
            `(${entry.platform})`
        );
      } else if (
        result?.status === "skipped"
      ) {
        results.skipped++;

        console.log(
          `[SKIPPED] ${entry.username} ` +
            `(${entry.platform})`
        );
      } else {
        results.unknown++;

        console.warn(
          `[UNKNOWN STATUS] ${entry.username} ` +
            `(${entry.platform})`,
          result
        );
      }
    } catch (error) {
      if (
        error instanceof GlobalPipelineError
      ) {
        console.error(`
================================
PIPELINE DIHENTIKAN

PENYEBAB : Gangguan global
CREATOR  : ${entry.username} (${entry.platform})
PROGRESS : ${processed}/${seed.length}

Creator yang gagal dan belum diproses tetap
berada dalam antrean untuk jadwal berikutnya.
================================
`);

        console.error(
          "[GLOBAL ERROR DETAIL]",
          error.originalError
        );

        throw error;
      }

      results.error++;

      console.error(
        `[FINAL ERROR] ${entry.username} ` +
          `(${entry.platform})`,
        error
      );
    }

    console.log(
      `[PROGRESS] ${processed}/${seed.length} selesai`
    );
  }

  const durationMinutes =
    (Date.now() - startedAt) /
    1000 /
    60;

  console.log(`
================================
SUMMARY

TOTAL     : ${seed.length}
PROCESSED : ${processed}
SUCCESS   : ${results.success}
SKIPPED   : ${results.skipped}
ERROR     : ${results.error}
UNKNOWN   : ${results.unknown}
DURATION  : ${durationMinutes.toFixed(2)} menit

================================
`);
}

main()
  .catch((error) => {
    console.error(
      "[FATAL ERROR]",
      error
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

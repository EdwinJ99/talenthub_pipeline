import "dotenv/config";

import { processCreator, prisma, type SeedEntry } from "../lib/pipeline";

const RETRY_COUNT = 3;

const RETRY_DELAY_MS = 5_000;

const REFRESH_AFTER_DAYS = 7;

/**

 * null = tidak membatasi jumlah creator pada mode otomatis.

 * Contoh: 50 = maksimal 50 creator per eksekusi.

 */

const CREATOR_LIMIT: number | null = null;

type SupportedPlatform = "instagram" | "tiktok";

type ManualCreator = {
  username: string;

  platform: SupportedPlatform;
};

/**

 * MODE MANUAL

 *

 * Isi username sekaligus platformnya.

 *

 * Username yang sama boleh dimasukkan dua kali selama

 * platformnya berbeda.

 *

 * Kosongkan array untuk kembali ke mode otomatis:

 *

 * const MANUAL_CREATORS: ManualCreator[] = [];

 */

const MANUAL_CREATORS: ManualCreator[] = [];

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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(
      resolve,

      milliseconds
    );
  });
}

function normalizeUsername(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()

    .replace(/^@+/, "")

    .toLowerCase();
}

function normalizePlatform(
  value: string | null | undefined
): SupportedPlatform | null {
  const platform = String(value ?? "")
    .trim()

    .toLowerCase();

  if (platform === "instagram" || platform === "ig") {
    return "instagram";
  }

  if (platform === "tiktok" || platform === "tik tok" || platform === "tt") {
    return "tiktok";
  }

  return null;
}

function platformAliases(platform: SupportedPlatform): string[] {
  if (platform === "instagram") {
    return ["instagram", "Instagram", "INSTAGRAM", "ig", "IG"];
  }

  return ["tiktok", "TikTok", "TIKTOK", "tik tok", "Tik Tok", "tt", "TT"];
}

function normalizeManualCreators(): ManualCreator[] {
  const uniqueCreators = new Map<string, ManualCreator>();

  for (const creator of MANUAL_CREATORS) {
    const username = normalizeUsername(creator.username);

    const platform = normalizePlatform(creator.platform);

    if (!username) {
      console.warn("[MANUAL] Entry dilewati karena username kosong.");

      continue;
    }

    if (!platform) {
      console.warn(
        `[MANUAL] ${username} dilewati karena platform tidak valid.`
      );

      continue;
    }

    const uniqueKey = `${platform}:${username}`;

    if (uniqueCreators.has(uniqueKey)) {
      console.warn(`[MANUAL] Duplikat dilewati: ${username} (${platform})`);

      continue;
    }

    uniqueCreators.set(
      uniqueKey,

      {
        username,

        platform,
      }
    );
  }

  return Array.from(uniqueCreators.values());
}

/**

 * Menggabungkan pesan error utama dan cause.

 */

function getErrorMessage(error: unknown): string {
  const messages: string[] = [];

  const visited = new Set<unknown>();

  let current: unknown = error;

  for (let depth = 0; depth < 5 && current; depth++) {
    if (visited.has(current)) {
      break;
    }

    visited.add(current);

    if (current instanceof Error) {
      messages.push(
        current.name,

        current.message
      );

      const errorWithCause = current as Error & {
        cause?: unknown;

        code?: unknown;
      };

      if (errorWithCause.code) {
        messages.push(String(errorWithCause.code));
      }

      current = errorWithCause.cause;

      continue;
    }

    if (typeof current === "object" && current !== null) {
      const objectError = current as {
        message?: unknown;

        code?: unknown;

        cause?: unknown;
      };

      if (objectError.message) {
        messages.push(String(objectError.message));
      }

      if (objectError.code) {
        messages.push(String(objectError.code));
      }

      current = objectError.cause;

      continue;
    }

    messages.push(String(current));

    break;
  }

  return messages

    .join(" ")

    .toLowerCase();
}

/**

 * Menentukan apakah kegagalan berasal dari gangguan global,

 * bukan hanya dari satu akun.

 */

function isGlobalFailure(error: unknown): boolean {
  const message = getErrorMessage(error);

  const globalErrorKeywords = [
    // Internet, DNS, dan koneksi

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

    // Apify token/quota

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

  return globalErrorKeywords.some((keyword) => message.includes(keyword));
}

/**

 * Mengambil creator dari database.

 *

 * Mode manual:

 * - Mencocokkan username DAN platform.

 * - Tidak terpengaruh last_scraped_at.

 *

 * Mode otomatis:

 * - last_scraped_at NULL; atau

 * - terakhir di-scrape minimal 7 hari lalu.

 */

async function loadSeedFromDatabase(): Promise<SeedEntry[]> {
  const refreshCutoff = new Date(
    Date.now() - REFRESH_AFTER_DAYS * 24 * 60 * 60 * 1000
  );

  const manualCreators = normalizeManualCreators();

  const isManualMode = manualCreators.length > 0;

  if (isManualMode) {
    console.log("[DATABASE] Mode manual:");

    for (const creator of manualCreators) {
      console.log(`  - ${creator.username} (${creator.platform})`);
    }
  } else {
    console.log(
      "[DATABASE] Mode otomatis: " +
        "mengambil creator yang belum di-scrape " +
        `atau sudah >= ${REFRESH_AFTER_DAYS} hari.`
    );
  }

  console.log(`[DATABASE] Batas refresh: ${refreshCutoff.toISOString()}`);

  const manualConditions = manualCreators.map((creator) => ({
    AND: [
      {
        username: {
          equals: creator.username,

          mode: "insensitive" as const,
        },
      },

      {
        social_media: {
          in: platformAliases(creator.platform),
        },
      },
    ],
  }));

  const creators = await prisma.mst_creators.findMany({
    where: isManualMode
      ? {
          OR: manualConditions,
        }
      : {
          AND: [
            {
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
            },

            {
              social_media: {
                in: [
                  "instagram",

                  "Instagram",

                  "INSTAGRAM",

                  "ig",

                  "IG",

                  "tiktok",

                  "TikTok",

                  "TIKTOK",

                  "tik tok",

                  "Tik Tok",

                  "tt",

                  "TT",
                ],
              },
            },
          ],
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

    ...(!isManualMode && CREATOR_LIMIT !== null
      ? {
          take: CREATOR_LIMIT,
        }
      : {}),
  });

  const uniqueCreators = new Map<string, SeedEntry>();

  for (const creator of creators) {
    const username = normalizeUsername(creator.username);

    const platform = normalizePlatform(creator.social_media);

    if (!username) {
      console.warn(`[SKIPPED DATABASE] ID ${creator.id}: username kosong`);

      continue;
    }

    if (!platform) {
      console.warn(
        `[SKIPPED DATABASE] ID ${creator.id}: ` +
          `platform tidak didukung (${creator.social_media})`
      );

      continue;
    }

    const uniqueKey = `${platform}:${username}`;

    if (uniqueCreators.has(uniqueKey)) {
      console.warn(`[SKIPPED DUPLICATE] ${username} (${platform})`);

      continue;
    }

    uniqueCreators.set(
      uniqueKey,

      {
        username,

        platform,
      }
    );
  }

  const seed = Array.from(uniqueCreators.values());

  /*

   * Cek target manual yang tidak ditemukan.

   * Pengecekan memakai kombinasi username + platform.

   */

  if (isManualMode) {
    const foundKeys = new Set(
      creators.flatMap((creator) => {
        const username = normalizeUsername(creator.username);

        const platform = normalizePlatform(creator.social_media);

        if (!username || !platform) {
          return [];
        }

        return [`${platform}:${username}`];
      })
    );

    const missingCreators = manualCreators.filter(
      (creator) => !foundKeys.has(`${creator.platform}:${creator.username}`)
    );

    if (missingCreators.length > 0) {
      console.warn("[DATABASE] Target manual tidak ditemukan:");

      for (const creator of missingCreators) {
        console.warn(`  - ${creator.username} (${creator.platform})`);
      }
    }
  }

  console.log(`[DATABASE] ${creators.length} row ditemukan`);

  console.log(`[DATABASE] ${seed.length} creator valid akan diproses`);

  return seed;
}

/**

 * Memproses satu creator maksimal tiga kali.

 */

async function processWithRetry(entry: SeedEntry) {
  let lastError: unknown;

  let lastFailureWasGlobal = false;

  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    try {
      console.log(
        `[ATTEMPT] ${entry.username} ` +
          `(${entry.platform}) ` +
          `${attempt}/${RETRY_COUNT}`
      );

      return await processCreator(entry);
    } catch (error) {
      lastError = error;

      lastFailureWasGlobal = isGlobalFailure(error);

      console.error(
        `[FAILED] ${entry.username} ` +
          `(${entry.platform}) ` +
          `percobaan ${attempt}/${RETRY_COUNT}`,

        error
      );

      if (lastFailureWasGlobal) {
        console.error("  [GLOBAL] Gangguan koneksi/token terdeteksi.");
      }

      if (attempt < RETRY_COUNT) {
        console.log(
          `[RETRY] ${entry.username}, ` +
            `menunggu ${RETRY_DELAY_MS / 1000} detik`
        );

        await sleep(RETRY_DELAY_MS);
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

  const seed = await loadSeedFromDatabase();

  const manualCreators = normalizeManualCreators();

  const isManualMode = manualCreators.length > 0;

  const instagramCount = seed.filter(
    (creator) => creator.platform === "instagram"
  ).length;

  const tiktokCount = seed.filter(
    (creator) => creator.platform === "tiktok"
  ).length;

  console.log(`

\================================

PIPELINE DATABASE



TOTAL CREATOR : ${seed.length}

INSTAGRAM     : ${instagramCount}

TIKTOK        : ${tiktokCount}

RETRY         : ${RETRY_COUNT} kali

MODE          : ${isManualMode ? "MANUAL" : "OTOMATIS"}

LIMIT         : ${isManualMode ? "SESUAI ARRAY" : CREATOR_LIMIT ?? "SEMUA"}

FILTER        : ${
    isManualMode
      ? "USERNAME + PLATFORM MANUAL"
      : `NULL atau terakhir scrape >= ${REFRESH_AFTER_DAYS} hari`
  }

\================================

`);

  if (seed.length === 0) {
    console.log("[SELESAI] Tidak ada creator yang perlu di-scrape.");

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

\================================

PROGRESS ${processed}/${seed.length}



\--- START ${entry.username} (${entry.platform}) ---

\================================

`);

    try {
      const result = await processWithRetry(entry);

      if (result?.status === "success") {
        results.success++;

        console.log(`[SUCCESS] ${entry.username} (${entry.platform})`);
      } else if (result?.status === "skipped") {
        results.skipped++;

        console.log(`[SKIPPED] ${entry.username} (${entry.platform})`);
      } else {
        results.unknown++;

        console.warn(
          `[UNKNOWN STATUS] ${entry.username} (${entry.platform})`,

          result
        );
      }
    } catch (error) {
      if (error instanceof GlobalPipelineError) {
        console.error(`

\================================

PIPELINE DIHENTIKAN



PENYEBAB : Gangguan global

CREATOR  : ${entry.username} (${entry.platform})

PROGRESS : ${processed}/${seed.length}



Creator yang gagal dan belum diproses tetap

berada dalam antrean untuk jadwal berikutnya.

\================================

`);

        console.error(
          "[GLOBAL ERROR DETAIL]",

          error.originalError
        );

        throw error;
      }

      results.error++;

      console.error(
        `[FINAL ERROR] ${entry.username} (${entry.platform})`,

        error
      );
    }

    console.log(`[PROGRESS] ${processed}/${seed.length} selesai`);
  }

  const durationMinutes = (Date.now() - startedAt) / 1000 / 60;

  console.log(`

\================================

SUMMARY



TOTAL     : ${seed.length}

PROCESSED : ${processed}

SUCCESS   : ${results.success}

SKIPPED   : ${results.skipped}

ERROR     : ${results.error}

UNKNOWN   : ${results.unknown}

DURATION  : ${durationMinutes.toFixed(2)} menit

\================================

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

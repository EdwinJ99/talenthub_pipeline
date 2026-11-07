
import "dotenv/config";

import {
  processCreator,
  prisma,
  type SeedEntry,
} from "../lib/pipeline";

// ==========================================
// CONFIGURATION
// ==========================================

const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 5_000;

// ==========================================
// PLATFORM CONFIGURATION
// ==========================================

type SupportedPlatform = "instagram" | "tiktok";

const SUPPORTED_PLATFORMS = [
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
];

// ==========================================
// ERROR HANDLING
// ==========================================

class GlobalPipelineError extends Error {
  constructor(
    message: string,
    public readonly originalError: unknown
  ) {
    super(message);
    this.name = "GlobalPipelineError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUsername(
  username: string | null | undefined
): string {
  return String(username ?? "")
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

function getErrorMessage(error: unknown): string {
  const messages: string[] = [];
  const visited = new Set<unknown>();

  let current: unknown = error;

  for (let depth = 0; depth < 5 && current; depth++) {
    if (visited.has(current)) break;

    visited.add(current);

    if (current instanceof Error) {
      messages.push(current.name, current.message);

      const detail = current as Error & {
        cause?: unknown;
        code?: unknown;
      };

      if (detail.code) {
        messages.push(String(detail.code));
      }

      current = detail.cause;
      continue;
    }

    if (typeof current === "object" && current !== null) {
      const detail = current as {
        message?: unknown;
        code?: unknown;
        cause?: unknown;
      };

      if (detail.message) {
        messages.push(String(detail.message));
      }

      if (detail.code) {
        messages.push(String(detail.code));
      }

      current = detail.cause;
      continue;
    }

    messages.push(String(current));
    break;
  }

  return messages.join(" ").toLowerCase();
}

function isGlobalFailure(error: unknown): boolean {
  const message = getErrorMessage(error);

  const keywords = [
    // Network
    "fetch failed",
    "eai_again",
    "enotfound",
    "econnrefused",
    "econnreset",
    "enetunreach",
    "etimedout",
    "network is unreachable",
    "socket hang up",

    // Database
    "can't reach database server",
    "p1001",
    "connection terminated",
    "connection timeout",
    "server has closed the connection",

    // Apify
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

  return keywords.some((keyword) => message.includes(keyword));
}

// ==========================================
// LOAD ALL CREATORS FROM DATABASE
// ==========================================

async function loadCreatorsFromDatabase(): Promise<SeedEntry[]> {
  console.log(
    "\n[DATABASE] Mengambil seluruh creator dari mst_creators..."
  );

  const creators = await prisma.mst_creators.findMany({
    where: {
      social_media: {
        in: SUPPORTED_PLATFORMS,
      },
    },

    select: {
      id: true,
      username: true,
      social_media: true,
      last_scraped_at: true,
    },

    // NULL lebih dahulu, kemudian yang paling
    // lama terakhir di-scrape.
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

    // TANPA take / limit.
    // Semua row yang cocok akan diambil.
  });

  const uniqueCreators = new Map<string, SeedEntry>();

  for (const creator of creators) {
    const username = normalizeUsername(creator.username);
    const platform = normalizePlatform(creator.social_media);

    if (!username) {
      console.warn(
        `[SKIP] Creator ID ${creator.id}: username kosong`
      );
      continue;
    }

    if (!platform) {
      console.warn(
        `[SKIP] ${username}: platform tidak didukung`
      );
      continue;
    }

    const key = `${platform}:${username}`;

    if (uniqueCreators.has(key)) {
      console.warn(
        `[DUPLICATE] ${username} (${platform}) dilewati`
      );
      continue;
    }

    uniqueCreators.set(key, {
      username,
      platform,
    });
  }

  const seed = Array.from(uniqueCreators.values());

  console.log(
    `[DATABASE] Total row ditemukan : ${creators.length}`
  );
  console.log(
    `[DATABASE] Creator valid       : ${seed.length}`
  );
  console.log(
    "[DATABASE] Limit               : TIDAK ADA"
  );

  return seed;
}

// ==========================================
// PROCESS WITH RETRY
// ==========================================

async function processWithRetry(entry: SeedEntry) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= RETRY_COUNT; attempt++) {
    try {
      console.log(
        `[ATTEMPT] ${entry.username} (${entry.platform}) ` +
        `${attempt}/${RETRY_COUNT}`
      );

      return await processCreator(entry);
    } catch (error) {
      lastError = error;

      console.error(
        `[FAILED] ${entry.username} (${entry.platform}) ` +
        `attempt ${attempt}/${RETRY_COUNT}`,
        error
      );

      if (attempt < RETRY_COUNT) {
        console.log(
          `[RETRY] Menunggu ${RETRY_DELAY_MS / 1000} detik...`
        );

        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  if (isGlobalFailure(lastError)) {
    throw new GlobalPipelineError(
      "Gangguan global setelah seluruh percobaan.",
      lastError
    );
  }

  throw lastError;
}

// ==========================================
// MAIN
// ==========================================

async function main(): Promise<void> {
  const startedAt = Date.now();

  // Ambil seluruh creator dari database.
  const seed = await loadCreatorsFromDatabase();

  const instagramCount = seed.filter(
    (creator) => creator.platform === "instagram"
  ).length;

  const tiktokCount = seed.filter(
    (creator) => creator.platform === "tiktok"
  ).length;

  console.log(`
========================================

DATABASE SCRAPING PIPELINE

SOURCE        : mst_creators

TOTAL CREATOR : ${seed.length}
INSTAGRAM     : ${instagramCount}
TIKTOK        : ${tiktokCount}

LIMIT         : UNLIMITED
RETRY         : ${RETRY_COUNT} kali

MODE          : DATABASE
PROCESS       : SEQUENTIAL (1 AKUN)
SCHEDULER     : EXTERNAL VPS

========================================
`);

  if (seed.length === 0) {
    console.log(
      "[SELESAI] Tidak ada creator yang dapat diproses."
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

  // ========================================
  // SEQUENTIAL PROCESSING
  // ========================================

  for (const entry of seed) {
    processed++;

    console.log(`
========================================

PROGRESS ${processed}/${seed.length}

START ${entry.username} (${entry.platform})

========================================
`);

    try {
      const result = await processWithRetry(entry);

      if (result?.status === "success") {
        results.success++;

        console.log(
          `[SUCCESS] ${entry.username} (${entry.platform})`
        );
      } else if (result?.status === "skipped") {
        results.skipped++;

        console.log(
          `[SKIPPED] ${entry.username} (${entry.platform})`
        );
      } else {
        results.unknown++;

        console.warn(
          `[UNKNOWN STATUS] ${entry.username}`,
          result
        );
      }
    } catch (error) {
      results.error++;

      if (error instanceof GlobalPipelineError) {
        console.error(
          "[GLOBAL ERROR] Pipeline dihentikan.",
          error.originalError
        );

        throw error;
      }

      console.error(
        `[FINAL ERROR] ${entry.username} (${entry.platform})`,
        error
      );
    }

    console.log(
      `[PROGRESS] ${processed}/${seed.length} selesai`
    );
  }

  // ========================================
  // SUMMARY
  // ========================================

  const durationMinutes =
    (Date.now() - startedAt) / 1000 / 60;

  console.log(`
========================================

SCRAPING SUMMARY

SOURCE    : mst_creators

TOTAL     : ${seed.length}
PROCESSED : ${processed}

SUCCESS   : ${results.success}
SKIPPED   : ${results.skipped}
ERROR     : ${results.error}
UNKNOWN   : ${results.unknown}

DURATION  : ${durationMinutes.toFixed(2)} menit

========================================
`);
}

// ==========================================
// EXECUTION
// ==========================================

main()
  .catch((error) => {
    console.error("[FATAL ERROR]", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

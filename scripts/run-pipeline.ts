import "dotenv/config";

import {
  processCreator,
  prisma,
  SeedEntry,
} from "../lib/pipeline";

const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 5000;
const CREATOR_LIMIT = 4;

async function sleep(ms: number) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
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

function normalizeUsername(
  value: string | null | undefined
): string {
  return String(value ?? "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
}

/**
 * Mengambil maksimal 50 creator dari mst_creators
 * yang belum pernah berhasil di-scrape.
 */
async function loadSeedFromDatabase(): Promise<
  SeedEntry[]
> {
  console.log(
    "[DATABASE] Mengambil maksimal 50 creator yang belum di-scrape..."
  );

  const creators =
    await prisma.mst_creators.findMany({
      where: {
        last_scraped_at: null,

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
      },

      orderBy: {
        id: "asc",
      },

      take: CREATOR_LIMIT,
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
        `[SKIPPED DATABASE] Creator ID ${creator.id}: username kosong`
      );

      continue;
    }

    if (!platform) {
      console.warn(
        `[SKIPPED DATABASE] ${username}: platform tidak didukung (${creator.social_media})`
      );

      continue;
    }

    const uniqueKey =
      `${platform}:${username}`;

    if (!uniqueCreators.has(uniqueKey)) {
      uniqueCreators.set(uniqueKey, {
        username,
        platform,
      });
    }
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

async function processWithRetry(
  entry: SeedEntry,
  retry: number = RETRY_COUNT
) {
  try {
    return await processCreator(entry);
  } catch (err) {
    console.error(
      `[FAILED] ${entry.username} (${entry.platform})`,
      err
    );

    if (retry <= 1) {
      throw err;
    }

    console.log(
      `[RETRY] ${entry.username}, ` +
      `sisa percobaan ${retry - 1}`
    );

    await sleep(RETRY_DELAY_MS);

    return processWithRetry(
      entry,
      retry - 1
    );
  }
}

async function main() {
  const startedAt = Date.now();

  const seed =
    await loadSeedFromDatabase();

  console.log(`
================================
PIPELINE DATABASE

TOTAL CREATOR : ${seed.length}
RETRY         : ${RETRY_COUNT} kali
LIMIT         : ${CREATOR_LIMIT}
FILTER        : last_scraped_at IS NULL
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
          `[SUCCESS] ${entry.username} (${entry.platform})`
        );
      } else if (
        result?.status === "skipped"
      ) {
        results.skipped++;

        console.log(
          `[SKIPPED] ${entry.username} (${entry.platform})`
        );
      } else {
        results.unknown++;

        console.warn(
          `[UNKNOWN STATUS] ${entry.username} (${entry.platform})`,
          result
        );
      }
    } catch (err) {
      results.error++;

      console.error(
        `[FINAL ERROR] ${entry.username} (${entry.platform})`,
        err
      );
    }

    console.log(
      `[PROGRESS] ${processed}/${seed.length} selesai`
    );
  }

  const durationMs =
    Date.now() - startedAt;

  const durationMinutes =
    durationMs / 1000 / 60;

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
  .catch((err) => {
    console.error(
      "[FATAL ERROR]",
      err
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
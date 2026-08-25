import "dotenv/config";
import { processCreator, prisma, SeedEntry } from "../lib/pipeline";

const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 5000;

// Masukkan username tanpa @
// Platform hanya boleh "instagram" atau "tiktok"
const seed: SeedEntry[] = [
  {
    username: "denny_caknan",
    platform: "instagram",
  },
];

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      `[RETRY] ${entry.username}, sisa percobaan ${retry - 1}`
    );

    await sleep(RETRY_DELAY_MS);

    return processWithRetry(entry, retry - 1);
  }
}

async function main() {
  const validSeed: SeedEntry[] = seed
    .map((entry) => ({
      ...entry,
      username: entry.username.trim().replace(/^@/, ""),
    }))
    .filter((entry) => entry.username.length > 0);

  console.log(`
================================
TOTAL CREATOR : ${validSeed.length}
RETRY         : ${RETRY_COUNT} kali
================================
`);

  const results = {
    success: 0,
    skipped: 0,
    error: 0,
  };

  for (const entry of validSeed) {
    console.log(`
--- START ${entry.username} (${entry.platform}) ---
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
  }

  console.log(`
================================
SUMMARY

TOTAL   : ${validSeed.length}
SUCCESS : ${results.success}
SKIPPED : ${results.skipped}
ERROR   : ${results.error}

================================
`);
}

main()
  .catch((err) => {
    console.error("[FATAL ERROR]", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
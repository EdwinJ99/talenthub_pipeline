import "dotenv/config";

import {
  processCreator,
  prisma,
  type SeedEntry,
} from "../lib/pipeline";

const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 5000;

/**
 * Daftar akun yang akan di-scrape.
 * Setiap akun wajib memiliki username dan platform.
 */
const creatorList: SeedEntry[] = [
 
  { username: "clsmelody", platform: "instagram" },
  { username: "yunishara36", platform: "instagram" }

];

async function sleep(
  milliseconds: number
): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Membersihkan username.
 */
function normalizeUsername(
  value: string | null | undefined
): string {
  return String(value ?? "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
}

/**
 * Memvalidasi isi array sekaligus menghapus duplikat.
 */
function loadSeedFromArray(): SeedEntry[] {
  const uniqueCreators = new Map<
    string,
    SeedEntry
  >();

  for (const creator of creatorList) {
    const username = normalizeUsername(
      creator.username
    );

    const platform = creator.platform;

    if (!username) {
      console.warn(
        "[SKIPPED ARRAY] Ditemukan username kosong"
      );

      continue;
    }

    if (
      platform !== "instagram" &&
      platform !== "tiktok"
    ) {
      console.warn(
        `[SKIPPED ARRAY] Platform tidak valid: ` +
          `${username} (${platform})`
      );

      continue;
    }

    const uniqueKey =
      `${platform}:${username}`;

    if (uniqueCreators.has(uniqueKey)) {
      console.warn(
        `[SKIPPED DUPLICATE] ` +
          `${username} (${platform})`
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

  const instagramCount = seed.filter(
    (creator) =>
      creator.platform === "instagram"
  ).length;

  const tiktokCount = seed.filter(
    (creator) =>
      creator.platform === "tiktok"
  ).length;

  console.log(
    `[ARRAY] ${creatorList.length} akun dimasukkan`
  );

  console.log(
    `[ARRAY] Instagram: ${instagramCount}`
  );

  console.log(
    `[ARRAY] TikTok: ${tiktokCount}`
  );

  console.log(
    `[ARRAY] ${seed.length} creator valid akan diproses`
  );

  return seed;
}

/**
 * Memproses satu creator dengan retry.
 */
async function processWithRetry(
  entry: SeedEntry
) {
  let lastError: unknown;

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

      console.error(
        `[FAILED] ${entry.username} ` +
          `(${entry.platform}) ` +
          `percobaan ${attempt}/${RETRY_COUNT}`,
        error
      );

      if (attempt < RETRY_COUNT) {
        console.log(
          `[RETRY] ${entry.username}, ` +
            `menunggu ${RETRY_DELAY_MS / 1000} detik`
        );

        await sleep(RETRY_DELAY_MS);
      }
    }
  }

  throw lastError;
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  // Daftar creator berasal dari array,
  // bukan dari query database.
  const seed = loadSeedFromArray();

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
PIPELINE ARRAY MANUAL

TOTAL CREATOR : ${seed.length}
INSTAGRAM     : ${instagramCount}
TIKTOK        : ${tiktokCount}
RETRY         : ${RETRY_COUNT} kali
SUMBER        : Array manual
================================
`);

  if (seed.length === 0) {
    console.log(
      "[SELESAI] Tidak ada creator valid untuk diproses."
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
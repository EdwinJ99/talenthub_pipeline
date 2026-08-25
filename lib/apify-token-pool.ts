import { ApifyClient } from "apify-client";
import { prisma } from "./prisma";

// Asumsi kasar siklus reset limit Apify: ~30 hari rolling dari saat token
// itu ketahuan kena limit. Kalau kamu tahu tanggal reset pasti tiap akun,
// ganti logic ini supaya hitung per-token, bukan flat 30 hari untuk semua.
const QUOTA_RESET_DAYS = 30;

// ============================================================================
// DETEKSI JENIS ERROR
// ============================================================================

type ApifyFailure = {
  statusCode?: unknown;
  status?: unknown;
  message?: unknown;
};

function failureDetails(error: unknown) {
  const value = error as ApifyFailure;
  const status = Number(value?.statusCode ?? value?.status ?? 0);
  const message = String(value?.message ?? "").toLowerCase();
  return { status, message };
}

export function isQuotaOrLimitError(err: unknown): boolean {
  const { status, message } = failureDetails(err);
  if (status === 429 || status === 402) return true;
  return /usage hard limit|monthly usage|insufficient.*credit|out of credit|rate limit|quota|exceeded your/.test(
    message
  );
}

function isInvalidTokenError(err: unknown): boolean {
  const { status, message } = failureDetails(err);
  if (status === 401) return true;
  return (
    /token|authentication|authorization/.test(message) &&
    /invalid|expired|revoked|unauthorized/.test(message)
  );
}

// .call() Apify TIDAK otomatis throw kalau run-nya gagal (misal karena
// kredit bulanan habis) — dia cuma balikin objek run apa adanya dengan
// status FAILED. Jadi harus dicek manual dan dilempar sebagai error sendiri,
// supaya withApifyClient bisa mendeteksi & rotasi token.
export function assertRunSucceeded(run: {
  status: string;
  statusMessage?: string | null;
}) {
  if (run.status !== "SUCCEEDED") {
    const err: any = new Error(
      run.statusMessage || `Actor run gagal dengan status: ${run.status}`
    );
    err.apifyRunStatus = run.status;
    throw err;
  }
}

// ============================================================================
// PEMILIHAN TOKEN — AMAN DARI RACE CONDITION
//
// Dipakai lewat transaksi + FOR UPDATE SKIP LOCKED: kalau ada beberapa
// proses (misal worker dengan concurrency > 1) manggil pickNextToken()
// BERSAMAAN, mereka tidak akan pernah dapat token yang sama di waktu yang
// sama — row yang sedang "dipegang" oleh transaksi lain otomatis dilewati
// (di-skip), bukan ditunggu.
// ============================================================================

interface ClaimedToken {
  id: number;
  token: string;
}

async function pickNextToken(): Promise<ClaimedToken | null> {
  const resetThreshold = new Date();
  resetThreshold.setDate(resetThreshold.getDate() - QUOTA_RESET_DAYS);

  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<ClaimedToken[]>`
      SELECT id, token
      FROM mst_apify_tokens
      WHERE is_active = true
        AND (quota_exceeded_at IS NULL OR quota_exceeded_at < ${resetThreshold})
      ORDER BY last_used_at ASC NULLS FIRST
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;

      if (rows.length === 0) return null;
      const claimed = rows[0];

      await tx.mst_apify_tokens.update({
        where: { id: claimed.id },
        data: { last_used_at: new Date() },
      });

      return claimed;
    },
    { maxWait: 10000, timeout: 10000 }
  );
}

async function markTokenExceeded(id: number) {
  await prisma.mst_apify_tokens.update({
    where: { id },
    data: { quota_exceeded_at: new Date() },
  });
}

async function markTokenInvalid(id: number) {
  await prisma.mst_apify_tokens.update({
    where: { id },
    data: { is_active: false },
  });
}

// ============================================================================
// ENTRY POINT — dipanggil oleh apify.ts (scrapeInstagramProfiles,
// scrapeTiktokProfiles, scrapeContentUrl, dst) untuk dapetin ApifyClient
// yang tokennya masih valid & belum kena limit. Kalau token yang dipilih
// ternyata kena limit/invalid PAS dipakai, otomatis rotasi ke token
// berikutnya tanpa perlu perubahan di pemanggilnya.
// ============================================================================

function isTransientDbError(err: unknown): boolean {
  const code = (err as any)?.code;
  return code === "P2028" || code === "P2024"; // transaction timeout / pool timeout
}

export async function withApifyClient<T>(
  operation: (client: ApifyClient) => Promise<T>
): Promise<T> {
  const triedTokenIds = new Set<number>();
  let lastError: unknown;
  let dbRetries = 0;

  while (true) {
    let candidate: ClaimedToken | null;
    try {
      candidate = await pickNextToken();
    } catch (err) {
      if (isTransientDbError(err) && dbRetries < 3) {
        dbRetries++;
        console.warn(
          `  [APIFY] pickNextToken timeout, retry ${dbRetries}/3...`
        );
        await new Promise((r) => setTimeout(r, 500 * dbRetries)); // backoff
        continue;
      }
      throw err;
    }

    // Semua token aktif sudah kena limit (atau tidak ada token sama sekali)
    if (!candidate) {
      throw new Error(
        `Semua token Apify kena limit/quota, invalid, atau belum ada token aktif di DB. Error terakhir: ${
          (lastError as any)?.message
        }`
      );
    }

    // Guard tambahan: kalau karena race condition token yang sama kepilih
    // lagi (harusnya jarang terjadi berkat FOR UPDATE SKIP LOCKED, tapi
    // dijaga di sini juga) — anggap semua sudah dicoba, berhenti.
    if (triedTokenIds.has(candidate.id)) {
      throw new Error(
        `Sudah muter balik ke token yang sama tanpa hasil. Error terakhir: ${
          (lastError as any)?.message
        }`
      );
    }
    triedTokenIds.add(candidate.id);

    const client = new ApifyClient({ token: candidate.token });

    try {
      return await operation(client);
    } catch (err) {
      lastError = err;

      if (isQuotaOrLimitError(err)) {
        console.warn(
          `  [APIFY] Token id ${candidate.id} kena limit/quota (${
            (err as any)?.message
          }). Rotasi ke token berikutnya...`
        );
        await markTokenExceeded(candidate.id);
        continue;
      }

      if (isInvalidTokenError(err)) {
        console.warn(
          `  [APIFY] Token id ${candidate.id} invalid/expired (${
            (err as any)?.message
          }). Menonaktifkan token, rotasi ke token berikutnya...`
        );
        await markTokenInvalid(candidate.id);
        continue;
      }

      // Error selain limit/invalid-token (input salah, actor error
      // internal, dll) — jangan rotasi, langsung lempar apa adanya.
      throw err;
    }
  }
}

// ============================================================================
// WATCHDOG OPSIONAL — kalau ada token yang ke-mark "quota_exceeded_at" tapi
// ternyata itu error yang salah deteksi (positif palsu), atau kamu tahu
// limitnya sudah pasti reset, panggil ini manual untuk "menghidupkan" lagi
// semua token yang exceeded-nya sudah lebih lama dari QUOTA_RESET_DAYS.
// Query di pickNextToken() sudah otomatis handle ini via resetThreshold,
// jadi function ini cuma buat kebutuhan manual/debug.
// ============================================================================

export async function forceResetAllExceededTokens() {
  const result = await prisma.mst_apify_tokens.updateMany({
    where: { quota_exceeded_at: { not: null } },
    data: { quota_exceeded_at: null },
  });
  console.log(
    `  [APIFY] ${result.count} token direset manual (quota_exceeded_at dikosongkan)`
  );
}

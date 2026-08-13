import { PrismaClient } from "@prisma/client";
import { ApifyClient } from "apify-client";

const prisma = new PrismaClient();

// Asumsi kasar siklus reset limit Apify: ~30 hari rolling dari saat token
// itu ketahuan kena limit. Kalau kamu tahu tanggal reset pasti tiap akun
// (biasanya berbasis tanggal daftar akun tsb), ganti logic ini supaya
// hitung per-token, bukan flat 30 hari untuk semua.
const QUOTA_RESET_DAYS = 30;

// ============================================================================
// DETEKSI ERROR LIMIT/QUOTA
// (persis logic yang sudah ada di apify.ts kamu sekarang — dipindah ke sini
//  supaya jadi satu sumber kebenaran, dipakai oleh callActorWithRotation)
// ============================================================================

export function isQuotaOrLimitError(err: any): boolean {
  const statusCode = err?.statusCode ?? err?.status;
  const type = err?.type ?? err?.error?.type ?? "";
  const message = String(err?.message ?? "").toLowerCase();

  if (statusCode === 429) return true;
  if (statusCode === 402) return true;
  if (type.includes("rate-limit")) return true;
  if (type.includes("limit-exceeded")) return true;

  if (
    message.includes("usage hard limit") ||
    message.includes("monthly usage") ||
    message.includes("insufficient funds") ||
    message.includes("insufficient credit") ||
    message.includes("exceeded your") ||
    message.includes("out of credit") ||
    message.includes("rate limit") ||
    message.includes("quota")
  ) {
    return true;
  }

  return false;
}

// .call() Apify TIDAK otomatis throw kalau run-nya gagal (misal karena
// kredit bulanan habis) — dia cuma balikin objek run apa adanya dengan
// status FAILED. Jadi harus dicek manual dan dilempar sebagai error sendiri,
// supaya callActorWithRotation bisa mendeteksi & rotasi token.
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

  return prisma.$transaction(async (tx) => {
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
  });
}

async function markTokenExceeded(id: number) {
  await prisma.mst_apify_tokens.update({
    where: { id },
    data: { quota_exceeded_at: new Date() },
  });
}

// ============================================================================
// ENTRY POINT — pengganti langsung callActorWithRotation yang lama di
// apify.ts. Signature-nya SAMA PERSIS, jadi tinggal ganti import-nya saja
// di apify.ts, tidak perlu ubah kode yang manggil actor Instagram/TikTok.
// ============================================================================

export async function callActorWithRotation<T>(
  runActor: (client: ApifyClient) => Promise<T>
): Promise<T> {
  const triedTokenIds = new Set<number>();
  let lastError: any;

  while (true) {
    const candidate = await pickNextToken();

    // Semua token aktif sudah kena limit (atau tidak ada token sama sekali)
    if (!candidate) {
      throw new Error(
        `Semua token Apify kena limit/quota, atau belum ada token aktif di DB. Error terakhir: ${lastError?.message}`
      );
    }

    // Guard tambahan: kalau karena race condition token yang sama kepilih
    // lagi (harusnya jarang terjadi berkat FOR UPDATE SKIP LOCKED, tapi
    // dijaga di sini juga) — anggap semua sudah dicoba, berhenti.
    if (triedTokenIds.has(candidate.id)) {
      throw new Error(
        `Sudah muter balik ke token yang sama tanpa hasil. Error terakhir: ${lastError?.message}`
      );
    }
    triedTokenIds.add(candidate.id);

    const client = new ApifyClient({ token: candidate.token });

    try {
      return await runActor(client);
    } catch (err: any) {
      lastError = err;

      if (!isQuotaOrLimitError(err)) {
        // Error selain limit (input salah, actor error internal, dll)
        // — jangan rotasi, langsung lempar apa adanya.
        throw err;
      }

      console.warn(
        `  [APIFY] Token id ${candidate.id} kena limit/quota (${err.message}). Rotasi ke token berikutnya...`
      );
      await markTokenExceeded(candidate.id);
    }
  }
}

// ============================================================================
// WATCHDOG OPSIONAL — kalau ada token yang ke-mark "quota_exceeded_at" tapi
// ternyata itu error yang salah deteksi (positif palsu), atau kamu tahu
// limitnya sudah pasti reset, panggil ini manual untuk "menghidupkan" lagi
// semua token yang exceeded-nya sudah lebih lama dari QUOTA_RESET_DAYS.
// Sebenarnya query di pickNextToken() sudah otomatis handle ini via
// resetThreshold, jadi function ini cuma buat kebutuhan manual/debug.
// ============================================================================

export async function forceResetAllExceededTokens() {
  const result = await prisma.mst_apify_tokens.updateMany({
    where: { quota_exceeded_at: { not: null } },
    data: { quota_exceeded_at: null },
  });
  console.log(`  [APIFY] ${result.count} token direset manual (quota_exceeded_at dikosongkan)`);
}

export { prisma as apifyTokenPrisma };
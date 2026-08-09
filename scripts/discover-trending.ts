import 'dotenv/config';
import { processCreator, prisma } from '../lib/pipeline';
import { discoverTrendingUsernames, DiscoveredCandidate } from '../lib/gemini';
import { validateUsernames } from '../lib/apify';

// Berapa kandidat yang diminta ke Gemini per-run
const CANDIDATE_COUNT = 5;

async function main() {
  console.log('=== [Flow 2] Discover username trending baru ===');

  // 1. Ambil semua username yang sudah ada, biar Gemini nggak nyaranin duplikat
  const allCreators = await prisma.mst_creators.findMany({
    select: { username: true },
  });
  const existingUsernames = allCreators.map(c => c.username);
  console.log(`Total username existing: ${existingUsernames.length}`);

  // 2. Minta Gemini cari kandidat baru yang lagi naik daun (pakai Google Search grounding)
  const candidates = await discoverTrendingUsernames(existingUsernames, CANDIDATE_COUNT);

  if (candidates.length === 0) {
    console.log('Gemini tidak mengembalikan kandidat baru. Selesai.');
    return;
  }

  console.log(`Gemini menyarankan ${candidates.length} kandidat:`);
  candidates.forEach(c =>
    console.log(`  - @${c.username} (${c.socialMedia})${c.reason ? ' — ' + c.reason : ''}`)
  );

  // 3. Validasi via Apify — WAJIB, ini filter utama anti-halusinasi.
  //    validateUsernames() butuh platform terpisah, jadi kandidat dipecah dulu.
  const igCandidates = candidates.filter(c => c.socialMedia === 'instagram');
  const ttCandidates = candidates.filter(c => c.socialMedia === 'tiktok');

  const validKeys = new Set<string>();

  if (igCandidates.length > 0) {
    console.log(`Validasi ${igCandidates.length} kandidat Instagram via Apify...`);
    const results = await validateUsernames(igCandidates.map(c => c.username), 'instagram');
    results
      .filter(r => r.valid)
      .forEach(r => validKeys.add(`${r.username.toLowerCase()}::instagram`));
  }

  if (ttCandidates.length > 0) {
    console.log(`Validasi ${ttCandidates.length} kandidat TikTok via Apify...`);
    const results = await validateUsernames(ttCandidates.map(c => c.username), 'tiktok');
    results
      .filter(r => r.valid)
      .forEach(r => validKeys.add(`${r.username.toLowerCase()}::tiktok`));
  }

  const validCandidates: DiscoveredCandidate[] = candidates.filter(c =>
    validKeys.has(`${c.username.toLowerCase()}::${c.socialMedia}`)
  );

  console.log(`${validCandidates.length} dari ${candidates.length} valid menurut Apify.`);

  if (validCandidates.length === 0) {
    console.log('Tidak ada kandidat valid untuk diproses. Selesai.');
    return;
  }

  // 4. Untuk yang valid: proses full lewat processCreator() — sama persis seperti
  //    flow 1 (scrape, cek lokasi Indonesia, klasifikasi kategori, gender, endorse, simpan DB).
  //    Kategori TIDAK diwariskan di sini karena bukan hasil mention, tetap dideteksi dari nol.
  const results = { success: 0, skipped: 0, error: 0 };

  for (const candidate of validCandidates) {
    try {
      const result = await processCreator({
        username: candidate.username,
        platform: candidate.socialMedia,
      });
      if (result?.status === 'success') results.success++;
      if (result?.status === 'skipped') results.skipped++;
    } catch (err) {
      console.error(`  [ERROR] ${candidate.username}:`, err);
      results.error++;
    }
  }

  console.log('\n=== [Flow 2] RINGKASAN ===');
  console.log(`Berhasil: ${results.success}`);
  console.log(`Dilewati: ${results.skipped}`);
  console.log(`Error: ${results.error}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
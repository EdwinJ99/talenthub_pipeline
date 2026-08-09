import 'dotenv/config';
import { processCreator, prisma, SeedEntry } from '../lib/pipeline';

const REFRESH_INTERVAL_DAYS = 7; // sesuai kesepakatan: refresh tiap 7 hari

async function main() {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - REFRESH_INTERVAL_DAYS);

  // Cuma ambil creator yang:
  // - belum pernah di-scrape sama sekali (last_scraped_at masih null), ATAU
  // - terakhir di-scrape SUDAH LEBIH dari REFRESH_INTERVAL_DAYS hari yang lalu
  const dueCreators = await prisma.mst_creators.findMany({
    where: {
      OR: [
        { last_scraped_at: null },
        { last_scraped_at: { lt: cutoffDate } },
      ],
    },
    select: { username: true, social_media: true, last_scraped_at: true },
  });

  const seed: SeedEntry[] = dueCreators.map(c => ({
    username: c.username,
    platform: c.social_media as 'instagram' | 'tiktok',
  }));

  console.log(
    `Total ${seed.length} akun jatuh tempo untuk di-refresh (interval ${REFRESH_INTERVAL_DAYS} hari)`
  );

  const results = { success: 0, skipped: 0, error: 0 };

  for (const entry of seed) {
    try {
      const result = await processCreator(entry);
      if (result?.status === 'success') results.success++;
      if (result?.status === 'skipped') results.skipped++;
    } catch (err) {
      console.error(`  [ERROR] ${entry.username}:`, err);
      results.error++;
    }
  }

  console.log('\n=== RINGKASAN ===');
  console.log(`Berhasil: ${results.success}`);
  console.log(`Dilewati: ${results.skipped}`);
  console.log(`Error: ${results.error}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
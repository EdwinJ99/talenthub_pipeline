import 'dotenv/config';
import { processCreator, prisma, SeedEntry } from '../lib/pipeline';

async function main() {
  const allCreators = await prisma.mst_creators.findMany({
    select: { username: true, social_media: true },
  });

  const seed: SeedEntry[] = allCreators.map(c => ({
    username: c.username,
    platform: c.social_media as 'instagram' | 'tiktok',
  }));

  console.log(`Total ${seed.length} akun akan diproses`);

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
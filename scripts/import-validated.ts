import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { processCreator } from '../lib/pipeline';

const prisma = new PrismaClient();

async function main() {
  const validOnes = await prisma.stg_discovered_usernames.findMany({
    where: { status: 'valid' },
  });

  console.log(`${validOnes.length} username valid siap diproses`);

  for (const item of validOnes) {
    const sourceCreator = item.source_creator_id
      ? await prisma.mst_creators.findUnique({
          where: { id: item.source_creator_id },
          include: { mst_categories: true },
        })
      : null;

    const categoryName = sourceCreator?.mst_categories?.name;
    if (!categoryName) {
      console.log(`  [SKIP] ${item.username} - tidak ada kategori referensi`);
      continue;
    }

    try {
      await processCreator({
        username: item.username,
        platform: item.social_media as 'instagram' | 'tiktok',
        category: categoryName,
      });

      await prisma.stg_discovered_usernames.update({
        where: { id: item.id },
        data: { status: 'imported' },
      });
    } catch (err) {
      console.error(`  [ERROR] ${item.username}:`, err);
    }
  }

  console.log('Selesai import.');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { validateUsernames } from '../lib/apify';

const prisma = new PrismaClient();

async function main() {
  const pending = await prisma.stg_discovered_usernames.findMany({
    where: { status: 'pending' },
  });

  console.log(`Ada ${pending.length} username pending buat divalidasi`);

  const byPlatform: Record<string, string[]> = {};
  for (const p of pending) {
    byPlatform[p.social_media] = byPlatform[p.social_media] ?? [];
    byPlatform[p.social_media].push(p.username);
  }

  for (const [platform, usernames] of Object.entries(byPlatform)) {
    console.log(`\nValidasi ${usernames.length} username di ${platform}...`);
    const results = await validateUsernames(usernames, platform as 'instagram' | 'tiktok');

    for (const r of results) {
      await prisma.stg_discovered_usernames.update({
        where: { username_social_media: { username: r.username, social_media: platform } },
        data: { status: r.valid ? 'valid' : 'invalid', validated_at: new Date() },
      });
      console.log(`  ${r.username}: ${r.valid ? 'VALID' : 'invalid'}`);
    }
  }

  console.log('\nSelesai validasi.');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
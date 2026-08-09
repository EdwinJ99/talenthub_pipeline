// scripts/fix-sequence.ts
import 'dotenv/config';
import { prisma } from '../lib/pipeline';

async function main() {
  const before = await prisma.$queryRawUnsafe<{ last_value: bigint }[]>(
    `SELECT last_value FROM mst_creators_id_seq`
  );
  const maxId = await prisma.$queryRawUnsafe<{ max: number }[]>(
    `SELECT MAX(id) AS max FROM mst_creators`
  );
  console.log('Sequence sebelum:', before[0].last_value);
  console.log('MAX(id) di tabel:', maxId[0].max);

  await prisma.$executeRawUnsafe(
    `SELECT setval(pg_get_serial_sequence('mst_creators', 'id'), (SELECT COALESCE(MAX(id), 1) FROM mst_creators))`
  );

  const after = await prisma.$queryRawUnsafe<{ last_value: bigint }[]>(
    `SELECT last_value FROM mst_creators_id_seq`
  );
  console.log('Sequence sesudah:', after[0].last_value);
}

main().finally(() => prisma.$disconnect());
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "fs";
import path from "path";

const prisma = new PrismaClient();

async function main() {
  const filePath = path.join(process.cwd(), "apify-tokens.txt");
  const raw = readFileSync(filePath, "utf-8");

  const tokens = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  if (tokens.length === 0) {
    console.log("Tidak ada token ditemukan di apify-tokens.txt");
    return;
  }

  console.log(`Ditemukan ${tokens.length} token, mulai seeding...`);

  let created = 0;
  let skipped = 0;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const existing = await prisma.mst_apify_tokens.findUnique({
      where: { token },
    });

    if (existing) {
      skipped++;
      continue;
    }

    await prisma.mst_apify_tokens.create({
      data: {
        token,
        label: `akun-${i + 1}`,
      },
    });
    created++;
  }

  console.log(
    `Selesai. ${created} token baru ditambahkan, ${skipped} sudah ada sebelumnya (dilewati).`
  );
}

main()
  .catch((err) => {
    console.error("Gagal seeding token:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

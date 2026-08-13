import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const tokens = await prisma.mst_apify_tokens.findMany({
    orderBy: { id: "asc" },
  });

  console.log(`Total token di DB: ${tokens.length}\n`);

  for (const t of tokens) {
    const res = await fetch("https://api.apify.com/v2/users/me", {
      headers: { Authorization: `Bearer ${t.token}` },
    });

    if (res.ok) {
      const data = await res.json();
      console.log(`OK   [${t.label}] ...${t.token.slice(-6)} -> user: ${data.data?.username}`);
    } else {
      console.log(`GAGAL [${t.label}] ...${t.token.slice(-6)} -> status ${res.status}`);
    }
  }

  await prisma.$disconnect();
}

main();
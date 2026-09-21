import "dotenv/config";
import { ApifyClient } from "apify-client";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/*
 * id 110 adalah akun-109.
 * Jadi akun-110 dimulai dari id 111.
 */
const START_FROM_ID = 262;

type TokenCheckResult = {
  id: number;
  label: string | null;
  valid: boolean;
  username?: string;
  error?: string;
};

function maskToken(token: string) {
  if (token.length <= 12) {
    return "********";
  }

  return `${token.slice(0, 12)}...${token.slice(-6)}`;
}

async function checkToken(
  id: number,
  label: string | null,
  token: string
): Promise<TokenCheckResult> {
  try {
    const client = new ApifyClient({
      token,
    });

    const user = await client
      .user()
      .get();

    return {
      id,
      label,
      valid: true,
      username: user.username,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    return {
      id,
      label,
      valid: false,
      error: message,
    };
  }
}

async function main() {
  console.log(
    "\n========================================"
  );
  console.log(
    "       APIFY TOKEN HEALTH CHECK"
  );
  console.log(
    "========================================\n"
  );

  console.log(
    `Mulai pengecekan dari ID ${START_FROM_ID} (akun-110)\n`
  );

  const tokens =
    await prisma.mst_apify_tokens.findMany({
      /*
       * Hanya mengambil akun-110 dan seterusnya.
       */
      where: {
        id: {
          gte: START_FROM_ID,
        },
      },

      orderBy: {
        id: "asc",
      },

      select: {
        id: true,
        token: true,
        label: true,
        is_active: true,
        quota_exceeded_at: true,
        last_used_at: true,
      },
    });

  console.log(
    `Total token yang akan diperiksa: ${tokens.length}\n`
  );

  if (tokens.length === 0) {
    console.log(
      `Tidak ada token dengan ID >= ${START_FROM_ID}.`
    );

    return;
  }

  const results: TokenCheckResult[] = [];

  for (const item of tokens) {
    console.log(
      `[CHECK] #${item.id} ${
        item.label ?? "-"
      } ${maskToken(item.token)}`
    );

    const result = await checkToken(
      item.id,
      item.label,
      item.token
    );

    results.push(result);

    if (result.valid) {
      console.log(
        `  ✅ VALID — Apify user: ${
          result.username ?? "-"
        }`
      );
    } else {
      console.log(
        `  ❌ INVALID — ${
          result.error ?? "Unknown error"
        }`
      );
    }

    console.log("");
  }

  const validTokens = results.filter(
    (item) => item.valid
  );

  const invalidTokens = results.filter(
    (item) => !item.valid
  );

  console.log(
    "\n========================================"
  );
  console.log(
    "               SUMMARY"
  );
  console.log(
    "========================================"
  );

  console.log(
    `Mulai ID: ${START_FROM_ID}`
  );

  console.log(
    `Total   : ${results.length}`
  );

  console.log(
    `Valid   : ${validTokens.length}`
  );

  console.log(
    `Invalid : ${invalidTokens.length}`
  );

  if (validTokens.length > 0) {
    console.log(
      "\n✅ TOKEN VALID:"
    );

    for (const item of validTokens) {
      console.log(
        `  #${item.id} ${
          item.label ?? "-"
        } → ${item.username ?? "-"}`
      );
    }
  }

  if (invalidTokens.length > 0) {
    console.log(
      "\n❌ TOKEN INVALID:"
    );

    for (const item of invalidTokens) {
      console.log(
        `  #${item.id} ${
          item.label ?? "-"
        } → ${
          item.error ?? "Unknown error"
        }`
      );
    }
  }

  console.log(
    "\n========================================\n"
  );
}

main()
  .catch((error) => {
    console.error(
      "\n[FATAL ERROR]",
      error
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
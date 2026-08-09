import "dotenv/config";
import { prisma, processCreator } from "../lib/pipeline";
import {
  scrapeInstagramProfileDetails,
  scrapeInstagramPosts,
  scrapeTiktokProfiles,
  RawProfile,
} from "../lib/apify";
import { checkIsInfluencerAccount } from "../lib/gemini";

async function main() {
  console.log("=== [Flow 3] Proses staging discovered usernames ===");

  const pending = await prisma.stg_discovered_usernames.findMany({
    where: { status: "pending" },
  });
  console.log(`Total pending: ${pending.length}`);

  const results = { approved: 0, rejected: 0, not_found: 0, error: 0 };

  for (const entry of pending) {
    const platform = entry.social_media as "instagram" | "tiktok";
    try {
      // 1. Scrape PROFIL DULU AJA (murah) — sekaligus jadi validasi eksistensi
      const profiles =
        platform === "instagram"
          ? await scrapeInstagramProfileDetails([entry.username])
          : await scrapeTiktokProfiles([entry.username]);
      const profile: RawProfile | undefined = profiles[0];

      if (!profile || !profile.isValid) {
        console.log(`  [SKIP] ${entry.username} — tidak ditemukan/invalid`);
        await prisma.stg_discovered_usernames.update({
          where: { id: entry.id },
          data: { status: "rejected", validated_at: new Date() },
        });
        results.not_found++;
        continue;
      }

      // 1b. Filter follower — SEBELUM narik posts, biar akun kekecilan
      //     nggak ikut kena request post yang mahal
      if (profile.followers < 5000) {
        console.log(
          `  [SKIP] ${entry.username} — follower ${profile.followers} < 5000`
        );
        await prisma.stg_discovered_usernames.update({
          where: { id: entry.id },
          data: { status: "rejected", validated_at: new Date() },
        });
        results.rejected++;
        continue;
      }

      // 1c. Baru sekarang narik posts — HANYA untuk akun yang lolos filter
      if (platform === "instagram" && profile.posts.length === 0) {
        profile.posts = await scrapeInstagramPosts(profile.username);
      }

      // 2. Klasifikasi KOL vs bukan
      const accountCheck = await checkIsInfluencerAccount(
        profile.username,
        profile.bio ?? "",
        profile.posts
      );

      if (!accountCheck.isInfluencer) {
        console.log(
          `  [REJECTED] ${entry.username} — ${accountCheck.accountType}: ${accountCheck.reason}`
        );
        await prisma.stg_discovered_usernames.update({
          where: { id: entry.id },
          data: { status: "rejected", validated_at: new Date() },
        });
        results.rejected++;
        continue;
      }

      // 3. Lolos → proses full pipeline (lokasi, kategori, gender, endorse, simpan)
      const result = await processCreator(
        { username: entry.username, platform },
        profile // sudah punya posts, nggak scrape ulang
      );

      await prisma.stg_discovered_usernames.update({
        where: { id: entry.id },
        data: {
          status: result?.status === "success" ? "approved" : "rejected",
          validated_at: new Date(),
        },
      });
      if (result?.status === "success") results.approved++;
      else results.rejected++;
    } catch (err) {
      console.error(`  [ERROR] ${entry.username}:`, err);
      results.error++;
    }
  }

  console.log("\n=== [Flow 3] RINGKASAN ===");
  console.log(`Approved: ${results.approved}`);
  console.log(`Rejected: ${results.rejected}`);
  console.log(`Not found: ${results.not_found}`);
  console.log(`Error: ${results.error}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
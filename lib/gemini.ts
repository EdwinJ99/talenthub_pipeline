import { GoogleGenerativeAI } from "@google/generative-ai";
import type { RawPost } from "./apify";

// ============================================================================
// ROTASI MULTI-API-KEY GEMINI

function getGeminiApiKeys(): string[] {
  // GEMINI_API_KEYS is the preferred multi-key setting. The two fallbacks keep
  // existing local installations compatible while they migrate their env name.
  const configuredKeys = process.env.GEMINI_API_KEYS
    ?? process.env.GEMINI_API_KEY
    ?? process.env["GEMINI-API_KEY"]
    ?? "";

  return configuredKeys
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
}

let currentKeyIndex = 0;

function getGenAI(): GoogleGenerativeAI {
  const keys = getGeminiApiKeys();
  if (keys.length === 0) {
    throw new Error("Gemini is not configured. Add GEMINI_API_KEYS to the deployment environment variables.");
  }
  currentKeyIndex %= keys.length;
  return new GoogleGenerativeAI(keys[currentKeyIndex]);
}

function isRateLimitOrQuotaError(err: any): boolean {
  const status = err?.status;
  return status === 429 || status === 503;
}

// Dipangkas jadi 1 model saja — flash-lite paling murah kuotanya.
// Kalau nanti kamu sudah punya key dari akun Google yang beda-beda beneran
// (bukan 1 project yang sama), boleh tambah lagi model lain di sini.
const MODEL_CANDIDATES = [
  "gemini-flash-lite-latest",
];

interface GenerateOptions {
  grounding?: boolean;
}

async function callModel(
  genAI: GoogleGenerativeAI,
  modelName: string,
  prompt: string,
  options?: GenerateOptions
): Promise<string> {
  const model = genAI.getGenerativeModel({
    model: modelName,
    ...(options?.grounding
      ? { tools: [{ googleSearch: {} } as any] }
      : {}),
  });
  const result = await model.generateContent(prompt);
  return result.response
    .text()
    .replace(/```json|```/g, "")
    .trim();
}

// Coba semua model di MODEL_CANDIDATES pakai API KEY YANG SEDANG AKTIF
// 10-15 detik per percobaan kalau memang kuotanya lagi habis semua.
async function tryAllModelsWithCurrentKey(
  prompt: string,
  options?: GenerateOptions
): Promise<string> {
  let lastError: any;

  for (const modelName of MODEL_CANDIDATES) {
    try {
      const genAI = getGenAI();
      return await callModel(genAI, modelName, prompt, options);
    } catch (err: any) {
      lastError = err;
      console.log(
        `  Gagal (status ${err?.status ?? "unknown"}) pakai ${modelName} (key index ${currentKeyIndex})`
      );
    }
  }

  throw lastError;
}

async function generateWithRetry(
  prompt: string,
  options?: GenerateOptions
): Promise<string> {
  const apiKeys = getGeminiApiKeys();
  if (apiKeys.length === 0) {
    throw new Error("Gemini is not configured. Add GEMINI_API_KEYS to the deployment environment variables.");
  }
  currentKeyIndex %= apiKeys.length;
  const startKeyIndex = currentKeyIndex;
  let attempts = 0;
  let lastError: any;

  // Lapis 1: coba semua model dengan key yang sedang aktif.
  // Kalau SEMUA model gagal karena rate-limit/quota (bukan error lain),
  // rotasi ke API key berikutnya dan ulangi dari model pertama lagi.
  while (attempts < apiKeys.length) {
    try {
      return await tryAllModelsWithCurrentKey(prompt, options);
    } catch (err: any) {
      lastError = err;

      if (!isRateLimitOrQuotaError(err)) {
        // Error selain limit (misal prompt di-block safety filter, dll)
        // — jangan rotasi key, langsung lempar ke fallback/luar.
        break;
      }

      console.warn(
        `  [GEMINI] Key index ${currentKeyIndex} kena limit. Rotasi ke key berikutnya...`
      );
      currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
      attempts++;

      // Kalau sudah muter balik ke key awal, berarti semua key sudah dicoba.
      if (currentKeyIndex === startKeyIndex) break;
    }
  }

  // Lapis 2: fallback terakhir — kalau grounding yang bikin semua gagal,
  // coba SEKALI lagi tanpa grounding, pakai key yang sedang aktif.
  if (options?.grounding) {
    console.log(
      "  Semua key/model gagal dengan grounding, coba fallback TANPA grounding..."
    );
    try {
      const genAI = getGenAI();
      return await callModel(genAI, MODEL_CANDIDATES[0], prompt, { grounding: false });
    } catch (fallbackErr) {
      lastError = fallbackErr;
    }
  }

  throw lastError;
}

export interface EndorseResult {
  index: number;
  isEndorse: boolean;
}

export async function detectEndorsePosts(
  username: string,
  posts: RawPost[]
): Promise<EndorseResult[]> {
  if (posts.length === 0) return [];

  const prompt = `
Kamu sistem deteksi konten endorse/iklan berbayar di social media.
Username: ${username}

Caption postingan (index dari 0):
${posts.map((p, i) => `[${i}] ${p.caption.slice(0, 300)}`).join("\n")}

Tandai setiap index apakah "endorse" (ada indikasi kerja sama berbayar/iklan brand: #ads, #sponsored,
kata "endorse", "kolaborasi berbayar", promosi produk dengan gaya jelas beriklan) atau bukan.

Balas HANYA JSON array, tanpa markdown, tanpa penjelasan:
[ { "index": 0, "isEndorse": true }, ... ]
`;

  const text = await generateWithRetry(prompt);

  try {
    return JSON.parse(text);
  } catch {
    console.error("  Gagal parse response Gemini:", text);
    return posts.map((_, i) => ({ index: i, isEndorse: false }));
  }
}

export async function classifyAccountCategory(
  username: string,
  bio: string,
  posts: RawPost[],
  existingCategories: string[]
): Promise<string> {
  const prompt = `
Kamu sistem klasifikasi kategori akun creator social media.
Username: ${username}
Bio: ${bio}
Contoh caption postingan:
${posts
  .slice(0, 10)
  .map((p) => p.caption.slice(0, 200))
  .join("\n---\n")}

Tentukan SATU kategori paling sesuai untuk akun ini (contoh: Fashion, Beauty, F&B, Gaming, Parenting, Fitness, dll).

Kategori yang SUDAH ADA di database (kalau akun ini cocok dengan salah satunya, PAKAI PERSIS nama ini,
jangan bikin nama baru yang mirip):
${
  existingCategories.length > 0
    ? existingCategories.join(", ")
    : "(belum ada kategori tersimpan)"
}

Kalau akun ini TIDAK cocok dengan kategori manapun di atas, boleh buat nama kategori baru yang singkat dan jelas.

Balas HANYA JSON, tanpa markdown:
{ "category": "nama_kategori" }
`;

  const text = await generateWithRetry(prompt);
  try {
    const parsed = JSON.parse(text);
    return parsed.category;
  } catch {
    console.error("  Gagal parse kategori dari Gemini:", text);
    return "Lainnya";
  }
}

export async function suggestNewUsernames(
  bio: string,
  posts: RawPost[]
): Promise<string[]> {
  const prompt = `
Dari bio dan caption postingan berikut, ekstrak semua username/handle social media lain yang di-mention
(biasanya diawali @), yang KEMUNGKINAN adalah akun creator/kolaborator lain, bukan brand resmi besar.

Bio: ${bio}
Caption:
${posts.map((p) => p.caption).join("\n")}

Balas HANYA array JSON berisi username tanpa "@", tanpa duplikat. Contoh: ["user1", "user2"]
Jika tidak ada, balas: []
`;

  const text = await generateWithRetry(prompt);

  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

export interface AccountTypeCheck {
  isInfluencer: boolean;
  accountType:
    | "personal_creator"
    | "brand_business"
    | "media_news"
    | "community_meme"
    | "other";
  reason: string;
}

export async function checkIsInfluencerAccount(
  username: string,
  bio: string,
  posts: RawPost[]
): Promise<AccountTypeCheck> {
  const prompt = `
Kamu sistem klasifikasi apakah sebuah akun social media adalah akun KOL/influencer PERSONAL
(individu yang membagikan kehidupan/konten pribadinya, punya audiens yang follow karena sosok orangnya),
BUKAN akun brand/toko online/official store/media berita/akun komunitas-meme.

Username: ${username}
Bio: ${bio}
Contoh caption postingan:
${posts
  .slice(0, 8)
  .map((p) => p.caption.slice(0, 200))
  .join("\n---\n")}

Indikasi BUKAN influencer personal: bio berisi link marketplace/toko, "official store", "customer service",
"order via WA/DM", caption isinya katalog produk dengan harga, akun berisi repost meme tanpa sosok personal,
akun media/redaksi berita.

Balas HANYA JSON, tanpa markdown:
{ "isInfluencer": true, "accountType": "personal_creator", "reason": "alasan singkat" }
`;

  const text = await generateWithRetry(prompt);
  try {
    return JSON.parse(text);
  } catch {
    console.error("  Gagal parse account type dari Gemini:", text);
    return { isInfluencer: false, accountType: "other", reason: "parse error" };
  }
}

export async function detectGender(
  username: string,
  name: string,
  bio: string
): Promise<"male" | "female" | "unknown"> {
  const prompt = `
Tebak gender pemilik akun social media ini berdasarkan nama dan bio (BUKAN dari foto).
Username: ${username}
Nama tampilan: ${name}
Bio: ${bio}

Kalau nama/bio tidak cukup jelas menunjukkan gender (misal nama brand, nama unik, atau ambigu), balas "unknown".

Balas HANYA JSON, tanpa markdown:
{ "gender": "male" }
atau { "gender": "female" }
atau { "gender": "unknown" }
`;

  const text = await generateWithRetry(prompt);
  try {
    const parsed = JSON.parse(text);
    if (["male", "female", "unknown"].includes(parsed.gender))
      return parsed.gender;
    return "unknown";
  } catch {
    return "unknown";
  }
}

export interface LocationCheck {
  status:
    | "indonesian"
    | "uncertain"
    | "not_indonesian";

  isIndonesian: boolean;
  confidence: number;
  cityGuess: string | null;
}

export async function checkIndonesianLocation(
  bio: string,
  posts: RawPost[]
): Promise<LocationCheck> {
  const captions = posts
    .slice(0, 10)
    .map((post, index) => {
      const caption = String(
        post.caption ?? ""
      ).trim();

      return caption
        ? `Caption ${index + 1}:\n${caption}`
        : "";
    })
    .filter(Boolean)
    .join("\n\n---\n\n");

  const prompt = `
Kamu adalah sistem klasifikasi untuk menentukan apakah pemilik akun media sosial berbasis di Indonesia.

PENTING:
- Jangan menentukan negara asal berdasarkan lokasi postingan.
- Creator Indonesia dapat sedang traveling, bekerja, belajar, atau membuat konten di luar negeri.
- Kota, negara, hotel, bandara, dan tempat wisata di caption bukan bukti domisili.
- Caption berbahasa Inggris tidak otomatis berarti akun bukan Indonesia.
- cityGuess hanya boleh diambil dari informasi domisili yang jelas di BIO.
- Jangan mengambil cityGuess dari lokasi perjalanan atau caption.

Gunakan indikator berikut:
1. Penggunaan Bahasa Indonesia atau bahasa daerah.
2. Konteks budaya, merek, organisasi, acara, atau masyarakat Indonesia.
3. Nomor kontak Indonesia dengan kode +62.
4. Agensi, manajemen, perusahaan, atau email bisnis Indonesia.
5. Identitas atau domisili Indonesia pada bio.
6. Aktivitas atau mayoritas audiens yang berhubungan dengan Indonesia.

Klasifikasikan menjadi salah satu:

1. "indonesian"
   Gunakan jika terdapat bukti yang cukup bahwa creator berbasis di Indonesia.

2. "uncertain"
   Gunakan jika informasi tidak cukup, bio kosong, caption terlalu sedikit,
   caption mayoritas bahasa Inggris, atau asal akun tidak dapat dipastikan.

3. "not_indonesian"
   Gunakan HANYA jika terdapat bukti kuat bahwa creator berbasis di negara lain
   dan tidak memiliki hubungan yang berarti dengan Indonesia.

Aturan confidence:
- Nilai antara 0 sampai 100.
- 80–100 untuk keputusan yang memiliki bukti kuat.
- 50–79 untuk indikasi cukup tetapi belum sepenuhnya pasti.
- Di bawah 50 jika informasinya tidak mencukupi.

BIO:
${String(bio ?? "").trim() || "(bio kosong)"}

CONTOH CAPTION:
${captions || "(caption tidak tersedia)"}

Balas HANYA JSON valid tanpa markdown:

{
  "status": "indonesian",
  "confidence": 90,
  "cityGuess": "Jakarta"
}

Contoh jika ragu:

{
  "status": "uncertain",
  "confidence": 40,
  "cityGuess": null
}

Contoh jika yakin bukan Indonesia:

{
  "status": "not_indonesian",
  "confidence": 90,
  "cityGuess": null
}
`;

  try {
    const text = await generateWithRetry(
      prompt
    );

    const cleanedText = String(text ?? "")
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const parsed = JSON.parse(cleanedText);

    const validStatuses = [
      "indonesian",
      "uncertain",
      "not_indonesian",
    ] as const;

    const status =
      validStatuses.includes(parsed.status)
        ? parsed.status
        : "uncertain";

    const rawConfidence = Number(
      parsed.confidence
    );

    const confidence = Number.isFinite(
      rawConfidence
    )
      ? Math.max(
          0,
          Math.min(100, rawConfidence)
        )
      : 0;

    /*
     * Keputusan "bukan Indonesia" hanya diterima
     * jika confidence minimal 80.
     *
     * Jika Gemini mengatakan bukan Indonesia tetapi
     * keyakinannya rendah, ubah menjadi uncertain.
     */
    const finalStatus =
      status === "not_indonesian" &&
      confidence < 80
        ? "uncertain"
        : status;

    const cityGuess =
      finalStatus === "indonesian" &&
      typeof parsed.cityGuess === "string" &&
      parsed.cityGuess.trim()
        ? parsed.cityGuess.trim()
        : null;

    return {
      status: finalStatus,

      isIndonesian:
        finalStatus === "indonesian",

      confidence,

      cityGuess,
    };
  } catch (error) {
    console.error(
      "[LOCATION CHECK] Gagal memeriksa lokasi:",
      error
    );

    /*
     * Jika Gemini error, jangan buang akun.
     */
    return {
      status: "uncertain",
      isIndonesian: false,
      confidence: 0,
      cityGuess: null,
    };
  }
}


// ============================================================================
// >>> BAGIAN BARU — FLOW 2 <<<
// Discovery aktif username trending (beda dari suggestNewUsernames() di atas,
// yang cuma ekstrak mention dari bio/caption). Di sini Gemini disuruh nyari
// sendiri lewat Google Search grounding, lalu WAJIB divalidasi Apify sebelum
// diproses. Dipanggil dari scripts/discover-trending.ts, jadwal terpisah
// (misal tiap 1-2 hari), tidak nyampur sama flow 1 yang tiap 12 jam.
// ============================================================================

export type DiscoveredCandidate = {
  username: string;
  socialMedia: "instagram" | "tiktok";
  reason?: string;
};

export async function discoverTrendingUsernames(
  existingUsernames: string[],
  count: number = 20
): Promise<DiscoveredCandidate[]> {
  const existingSample = existingUsernames.slice(0, 300).join(", ");

  const prompt = `
Cari ${count} username influencer/content creator Instagram dan TikTok asal Indonesia
yang sedang naik daun/trending belakangan ini (bukan artis nasional yang sudah sangat terkenal).

Gunakan hasil pencarian web untuk memastikan akun ini benar-benar ada dan aktif,
jangan mengarang username hanya berdasarkan pola nama yang terdengar masuk akal.

Jangan sertakan username berikut karena sudah ada di database:
${existingSample}

Jawab HANYA dalam format JSON array, tanpa teks tambahan, tanpa markdown code block:
[
  { "username": "contohuser1", "socialMedia": "instagram", "reason": "alasan singkat" },
  { "username": "contohuser2", "socialMedia": "tiktok", "reason": "alasan singkat" }
]
`;

  let parsed: DiscoveredCandidate[] = [];
  try {
    const text = await generateWithRetry(prompt, { grounding: true });
    parsed = JSON.parse(text);
  } catch (error) {
    console.error("  Gagal dapat/parse kandidat trending dari Gemini:", error);
    return [];
  }

  // Safety net di level kode — jangan cuma andalkan instruksi prompt
  const existingLower = new Set(existingUsernames.map((u) => u.toLowerCase()));
  const seen = new Set<string>();
  const cleanCandidates: DiscoveredCandidate[] = [];

  for (const c of parsed) {
    if (!c?.username || !c?.socialMedia) continue;

    const key = `${c.username.toLowerCase()}::${c.socialMedia}`;
    if (seen.has(key)) continue;
    if (existingLower.has(c.username.toLowerCase())) continue;
    if (c.socialMedia !== "instagram" && c.socialMedia !== "tiktok") continue;

    seen.add(key);
    cleanCandidates.push({
      username: c.username.trim().replace(/^@/, ""),
      socialMedia: c.socialMedia,
      reason: c.reason,
    });
  }

  return cleanCandidates;
}

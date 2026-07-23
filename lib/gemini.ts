import { GoogleGenerativeAI } from "@google/generative-ai";
import type { RawPost } from "./apify";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

const MODEL_CANDIDATES = [
  "gemini-flash-latest",
  "gemini-3.5-flash",
  "gemini-flash-lite-latest",
];

async function callModel(modelName: string, prompt: string): Promise<string> {
  const model = genAI.getGenerativeModel({ model: modelName });
  const result = await model.generateContent(prompt);
  return result.response
    .text()
    .replace(/```json|```/g, "")
    .trim();
}

async function generateWithRetry(prompt: string): Promise<string> {
  let lastError: any;

  for (const modelName of MODEL_CANDIDATES) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (attempt > 1) {
          const waitMs = attempt * 5000;
          console.log(
            `  Tunggu ${waitMs / 1000}s sebelum coba lagi (${modelName})...`
          );
          await new Promise((r) => setTimeout(r, waitMs));
        }
        return await callModel(modelName, prompt);
      } catch (err: any) {
        lastError = err;
        const isOverloaded = err?.status === 503 || err?.status === 429;
        console.log(
          `  Gagal (status ${err?.status ?? "unknown"}) pakai ${modelName}`
        );
        if (!isOverloaded) break;
      }
    }
    console.log(`  Pindah ke model berikutnya...`);
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
${posts.slice(0, 10).map(p => p.caption.slice(0, 200)).join('\n---\n')}

Tentukan SATU kategori paling sesuai untuk akun ini (contoh: Fashion, Beauty, F&B, Gaming, Parenting, Fitness, dll).

Kategori yang SUDAH ADA di database (kalau akun ini cocok dengan salah satunya, PAKAI PERSIS nama ini,
jangan bikin nama baru yang mirip):
${existingCategories.length > 0 ? existingCategories.join(', ') : '(belum ada kategori tersimpan)'}

Kalau akun ini TIDAK cocok dengan kategori manapun di atas, boleh buat nama kategori baru yang singkat dan jelas.

Balas HANYA JSON, tanpa markdown:
{ "category": "nama_kategori" }
`;

  const text = await generateWithRetry(prompt);
  try {
    const parsed = JSON.parse(text);
    return parsed.category;
  } catch {
    console.error('  Gagal parse kategori dari Gemini:', text);
    return 'Lainnya';
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

export async function detectGender(
  username: string,
  name: string,
  bio: string
): Promise<'male' | 'female' | 'unknown'> {
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
    if (['male', 'female', 'unknown'].includes(parsed.gender)) return parsed.gender;
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface LocationCheck {
  isIndonesian: boolean;
  cityGuess: string | null;
}

export async function checkIndonesianLocation(
  bio: string,
  posts: RawPost[]
): Promise<LocationCheck> {
  const prompt = `
Kamu sistem deteksi apakah sebuah akun social media adalah akun asal Indonesia.

Bio: ${bio}
Contoh caption postingan:
${posts
  .slice(0, 5)
  .map((p) => p.caption)
  .join("\n---\n")}

Berdasarkan bahasa yang dipakai (Bahasa Indonesia/daerah), lokasi yang disebut, konteks budaya,
tentukan apakah akun ini KEMUNGKINAN BESAR berbasis di Indonesia.

Balas HANYA JSON, tanpa markdown:
{ "isIndonesian": true, "cityGuess": "Jakarta" }
atau
{ "isIndonesian": false, "cityGuess": null }

Kalau kota tidak bisa ditebak dari bio/caption, cityGuess harus null meskipun isIndonesian true.
`;

  const text = await generateWithRetry(prompt);
  try {
    return JSON.parse(text);
  } catch {
    return { isIndonesian: false, cityGuess: null };
  }
}

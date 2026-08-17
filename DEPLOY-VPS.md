# Peran VPS di setup ini

Website (yang diakses lewat browser) sudah di-deploy di Vercel:
https://talenthub-agum.vercel.app/

VPS di sini **TIDAK** menjalankan web server — VPS cuma dipakai buat
menjalankan 3 script background job (`run-pipeline.ts`,
`process-staging.ts`, `discover-trending.ts`) sesuai jadwal. Ketiga
script itu langsung membaca/menulis ke database Neon yang sama dengan
yang dipakai website di Vercel — jadi begitu script selesai jalan,
datanya otomatis kelihatan di website tanpa perlu langkah tambahan.

# 1. Siapkan `.env` di VPS

Buat file `.env` **langsung di VPS** (jangan commit ke git), isinya sama
seperti `.env` lokal kamu — `DATABASE_URL`, `GEMINI_API_KEYS`, dan
variable lain yang dibutuhkan script-script ini.

Token Apify **tidak** perlu ada di `.env` — semua token sudah disimpan
di tabel `mst_apify_tokens` di database, otomatis kebawa selama
`DATABASE_URL` mengarah ke database yang sama.

# 2. Clone project & build image

```bash
git clone <repo-kamu> talenthub-pipeline
cd talenthub-pipeline

# taruh .env di sini (scp dari lokal, atau bikin manual)

# build image (BUKAN "up" — tidak ada service yang perlu nyala terus)
docker compose build
```

# 3. Sinkronisasi database (sekali di awal, dan tiap ada perubahan schema)

```bash
docker compose run --rm web npx prisma migrate deploy
```

(`migrate deploy` — versi aman buat production, cuma nerapin migration
yang sudah dibuat lewat `migrate dev` di lokal, nggak akan nanya-nanya
interaktif atau bikin migration baru sendiri)

**PENTING — JANGAN PERNAH jalankan `prisma migrate reset` di VPS, apapun
errornya.** Kalau muncul pesan "drift detected" atau semacamnya, STOP dan
cek dulu ke pemilik project, jangan langsung reset.

# 4. Pasang jadwal cron

Bikin folder log di dalam project:
```bash
mkdir -p logs
```

Buka crontab VPS:
```bash
crontab -e
```

Tambahkan 3 baris ini (ganti `/path/to/talenthub-pipeline` dengan lokasi
project yang sebenarnya di VPS):

```cron
# run-pipeline.ts - tiap Senin jam 02:00
0 2 * * 1 cd /path/to/talenthub-pipeline && docker compose run --rm web npx tsx scripts/run-pipeline.ts >> logs/run-pipeline.log 2>&1

# process-staging.ts - tiap Kamis jam 02:00
0 2 * * 4 cd /path/to/talenthub-pipeline && docker compose run --rm web npx tsx scripts/process-staging.ts >> logs/process-staging.log 2>&1

# discover-trending.ts - tiap 2 hari sekali jam 02:00
0 2 */2 * * cd /path/to/talenthub-pipeline && docker compose run --rm web npx tsx scripts/discover-trending.ts >> logs/discover-trending.log 2>&1
```

Cek kesimpen dengan benar:
```bash
crontab -l
```

# 5. Test manual dulu (sebelum percaya jadwal cron)

```bash
cd /path/to/talenthub-pipeline
docker compose run --rm web npx tsx scripts/discover-trending.ts >> logs/discover-trending.log 2>&1
cat logs/discover-trending.log
```

Kalau ini jalan sukses dan filenya keisi, cron-nya aman dipasang.

# 6. Cek log kapan pun

```bash
tail -f logs/run-pipeline.log
tail -f logs/process-staging.log
tail -f logs/discover-trending.log
```

# Update ke versi baru (setelah git pull perubahan kode)

```bash
git pull
docker compose build
```

Cron berikutnya otomatis pakai image yang baru — nggak perlu restart apa
pun, karena memang tidak ada service yang jalan terus-menerus.
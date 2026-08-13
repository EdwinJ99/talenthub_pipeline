SETUP CRON UNTUK 3 SCRIPT TERJADWAL - TALENTHUB PIPELINE
===========================================================

Prasyarat: container "web" sudah ke-build dan .env sudah terpasang
di VPS (sudah jalankan "docker compose up -d --build" duluan).

Log disimpan di folder "logs/" DI DALAM PROJECT (bukan di
/var/log), jadi gampang diakses tanpa perlu akses root/sudo.


LANGKAH 1 - Bikin folder logs di dalam project
-------------------------------------------
cd /path/to/talenthub-pipeline
mkdir -p logs

Tambahkan baris ini ke file .gitignore (biar file log nggak
ikut ke-push ke GitHub):
logs/


LANGKAH 2 - Buka crontab VPS
-------------------------------------------
crontab -e


LANGKAH 3 - Tempel 3 baris ini
-------------------------------------------
PENTING: ganti "/path/to/talenthub-pipeline" dengan lokasi project
yang sebenarnya di VPS (contoh: /home/user/talenthub-pipeline)
sebelum ditempel.

# run-pipeline.ts - tiap Senin jam 02:00 AM
0 2 * * 1 cd /path/to/talenthub-pipeline && docker compose run --rm web npx tsx scripts/run-pipeline.ts >> logs/run-pipeline.log 2>&1

# process-staging.ts - tiap Kamis jam 02:00 AM
0 2 * * 4 cd /path/to/talenthub-pipeline && docker compose run --rm web npx tsx scripts/process-staging.ts >> logs/process-staging.log 2>&1

# discover-trending.ts - tiap 2 hari sekali jam 02:00 AM
0 8 * * * cd /path/to/talenthub-pipeline && docker compose run --rm web npx tsx scripts/discover-trending.ts >> logs/discover-trending.log 2>&1

Cara simpan & keluar:
- nano   -> Ctrl+X, lalu Y, lalu Enter
- vim    -> tekan Esc, ketik :wq, lalu Enter


LANGKAH 4 - Pastikan kesimpen dengan benar
-------------------------------------------
crontab -l

Harus muncul 3 baris yang tadi ditempel.


LANGKAH 5 - Test manual dulu (jangan langsung percaya cron)
-------------------------------------------
cd /path/to/talenthub-pipeline
docker compose run --rm web npx tsx scripts/discover-trending.ts >> logs/discover-trending.log 2>&1

Cek isinya:
cat logs/discover-trending.log

Kalau ini jalan sukses tanpa error dan filenya keisi, berarti
cron-nya aman jalan sesuai jadwal nanti.


LANGKAH 6 - Cek log kapan pun (setelah cron jalan)
-------------------------------------------
tail -f logs/run-pipeline.log
tail -f logs/process-staging.log
tail -f logs/discover-trending.log


RINGKASAN JADWAL
-------------------------------------------
run-pipeline.ts        -> Senin,  02:00
process-staging.ts     -> Kamis,  02:00
discover-trending.ts   -> Setiap hari, 08:00

Format hari cron: 1 = Senin, 4 = Kamis, * = setiap hari.
Jam mengikuti timezone default VPS - cek dulu dengan perintah
"date", sesuaikan angka jamnya kalau VPS bukan WIB.
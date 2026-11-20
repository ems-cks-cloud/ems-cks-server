# EMS PT Citra Kenyalang Sakti — Server Online v1.4.1

Server Node.js tanpa dependensi untuk aplikasi EMS (multi-user, realtime via SSE).
Aplikasi web ada di `public/index.html` (satu berkas).

## Menjalankan lokal
```
node server.js        # PORT default 8787
```

## Variabel lingkungan (wajib di hosting)
- `EMS_GH_TOKEN` — token GitHub (fine-grained PAT, izin Contents: Read&Write)
- `EMS_GH_REPO`  — repo data privat, mis. `ems-cks-cloud/ems-cks-data`
- `EMS_GH_BRANCH`— opsional, default `main`

Data (db.json, auth.json, lampiran, backup) otomatis disalin ke repo data GitHub
setiap ada perubahan (debounce 15 dtk), tiap 5 menit bila kotor, dan saat server
berhenti (SIGTERM). Saat server nyala, data ditarik kembali dari repo — jadi
filesystem hosting yang temporer (Render free) tidak menghilangkan data.

## Update aplikasi (versi HTML baru)
1. Ganti `public/index.html` dengan berkas HTML versi baru.
2. `git add -A && git commit -m "update aplikasi" && git push`
3. Render auto-deploy dari branch main (±1-2 menit). Data pengguna tetap aman
   karena tersimpan di repo data terpisah.

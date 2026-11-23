# ZONA A1 — Deploy notifikasi (Web Push)

## Cara kerja saat ini (bukan BiQuote)

- **Satu-satunya sumber harga: WebSocket Exness** yang dipegang Durable Object
  `TickWatcher`. Tidak ada polling harga (BiQuote sudah dihapus) dan tidak ada
  fallback harga.
- **Cron per menit hanya watchdog/bootstrap** (`runPushAlerts` → `pingWatcher("/ensure")`).
  Cron tidak mengambil harga dan tidak pernah mengirim push.
- **Dua jalur trigger** (keduanya menulis state yang sama di D1):
  1. `TickWatcher`: tiap tick Exness dievaluasi vs zona BR1/BR2 dari D1.
     Trigger memakai harga sisi zona — **bid untuk BUY, ask untuk SELL** (bukan mid).
  2. `POST /api/zones/trigger` (auth `X-API-Key`, key sama dengan `/api/zones`):
     EA mengirim event sentuhan zona langsung. Zona tidak aktif → HTTP 200
     `{ok:true, fired:false, reason:"zone-not-active"}`; sudah pernah trigger →
     `{ok:true, fired:false, reason:"already-triggered"}`.
- **Pengumuman zona baru FRESH:** begitu `TickWatcher` pertama kali melihat zona
  FRESH di snapshot EA, HP berbunyi sekali per zona — judul `NEW ZONE BUY M1 · BR1`
  (tag `a1-new-zone-<timestamp>`), terpisah dari notif trigger. Sekali per zona:
  dicatat persisten di D1 `zone_announcement_state`, jadi DO restart tidak
  mengumumkan ulang; kalau zona hilang dari snapshot, catatannya dihapus dan zona
  yang sama boleh diumumkan lagi saat terbentuk kembali. Kalau kirim gagal total,
  dicoba lagi setelah jeda 60 detik (tidak ditandai announced). Catatan: kalau harga
  sudah di dalam zona baru itu, notif TRIGGERED bisa menyusul beberapa detik
  kemudian — itu dua kejadian berbeda, bukan duplikat. Status pengumuman terakhir
  terlihat di `GET /tick-watcher/status` → `last_announce`.
- **Alert news 15 menit sebelum rilis (23 Nov 2026):** cron tiap menit cek
  kalender BiQuote (sama dengan yang tampil di web). Rilis **high-impact USD**
  yang masuk jendela 15 menit → push sekali per event (tag `a1-news-<timestamp>`),
  jam tampil WIB, tercatat di D1 `news_alert_state`. Kalau kirim gagal total,
  dicoba lagi menit berikutnya. Cek terakhir: `GET /api/push/status` (admin) →
  `last_news_alert`. Kalender di-fetch paling cepat tiap 5 menit (cache D1).
- **Reset trigger:** zona yang sudah trigger akan boleh berbunyi lagi setelah harga
  sisi zona keluar dari `[lo − 0.5, hi + 0.5]` USD. Tanpa keluar zona, tidak ada
  notif kedua untuk zona yang sama.
- **Push gagal = boleh retry:** kalau `sendAll()` gagal total padahal ada subscriber
  (`sent == 0 && failed > 0`), penanda trigger dilepas dan zona boleh dicoba lagi
  setelah jeda 60 detik. Kalau tidak ada subscriber, zona tetap ditandai triggered.
- **TTL push 3600 detik (1 jam).** HP offline/Doze lebih lama dari itu saat trigger
  → push dibuang push service.
- **Tag notifikasi unik per alert** (`a1-zone-<timestamp>`), jadi tiap trigger tampil
  sendiri di tray, bukan menimpa notifikasi sebelumnya.
- **Riwayat alert:** tiap alert dicatat di D1 `push_history` (50 terbaru) dan bisa
  dibaca publik lewat `GET /api/push/history` (20 terbaru). Isi notif terakhir
  tetap di `GET /api/push/last`.
- **Normalisasi simbol:** `XAUUSDm`/`XAUUSDc` dinormalisasi ke `XAUUSD` untuk snapshot
  zona, state trigger, dan lookup zona. Subscribe WebSocket tetap memakai simbol
  persis akun (`EXN_SYMBOL`, mis. `XAUUSDm`).
- **Subscription 403:** endpoint 404/410 selalu dihapus. Endpoint 403 dihapus hanya
  kalau ada endpoint lain yang sukses (403 spesifik ke subscription itu). Kalau
  semua gagal 403, tidak ada yang dihapus — itu pertanda VAPID mismatch global
  (lihat log Worker `VAPID_MISMATCH_SUSPECTED`).

## Keamanan (20 Nov 2026)

- **Rotasi `API_SECRET` (wajib):** nilai default lama `SignalApiKey` di EA sudah
  bocor di repo publik. Set secret baru: `npx wrangler secret put API_SECRET`,
  lalu isi input EA `SignalApiKey` dengan nilai yang sama dan compile ulang EA.
  Sampai secret diganti, sinyal EA ditolak (401). `ZONES_API_KEY` tidak bocor
  (default EA kosong) — tapi kalau nilainya pendek/mudah ditebak, rotasi juga
  dengan `npx wrangler secret put ZONES_API_KEY`.
- **Rate limit (D1, per IP, jendela 60 detik):** subscribe 5/menit, zones
  30/menit, trigger 60/menit, signal 60/menit. Kena limit → HTTP 429 +
  header `Retry-After`. Pemakaian normal EA tidak akan kena.
- **Batas keras (opsional):** di dashboard Cloudflare → Security → WAF →
  Rate limiting rules, buat rule untuk path `/api/*` (mis. 100 request/menit
  per IP, aksi Block 10 menit). Ini menahan banjir sebelum sampai ke Worker.
- **Header keamanan** dikirim di semua respons JSON Worker (nosniff, DENY
  framing, HSTS, CSP `default-src 'none'`). Halaman di GitHub Pages tidak bisa
  diset header-nya — kalau mau penuh, pindah frontend ke Cloudflare Pages.

## Deploy

Jalankan PowerShell dari folder `worker`:

```powershell
npx wrangler deploy
```

Worker sudah masuk version control (`.gitignore` tidak lagi mengecualikan `/worker/`).
Pastikan secret `VAPID_PUBLIC`, `VAPID_PRIVATE_JWK`, `PUSH_ADMIN_TOKEN`,
`ZONES_API_KEY` (fallback `API_SECRET`), `EXN_API_KEY`, `EXN_PRIVATE_KEY`,
`EXN_ACCOUNT_ID`, serta salah satu `EXN_ACCESS_POINT` / `EXN_GATEWAY_URL` tetap
tersedia di Cloudflare. D1 binding dan Durable Object binding yang lama dipertahankan.

## Diagnosis

Endpoint (ganti `DOMAIN-WORKER` dengan domain Worker, mis.
`zona-a1-signal-api.landungprakoso14.workers.dev`):

```powershell
# Status lengkap: subscriber, push terakhir, status TickWatcher
curl.exe -H "X-Admin-Token: TOKEN_PUSH_ADMIN" "https://DOMAIN-WORKER/api/push/status"
# Status TickWatcher saja (publik, tanpa auth)
curl.exe "https://DOMAIN-WORKER/tick-watcher/status"
# Riwayat alert (publik, tanpa auth)
curl.exe "https://DOMAIN-WORKER/api/push/history"
# Snapshot zona yang diterima dari EA
curl.exe "https://DOMAIN-WORKER/api/zones?symbol=XAUUSD"
```

Tes push:

```powershell
curl.exe -X POST -H "X-Admin-Token: TOKEN_PUSH_ADMIN" "https://DOMAIN-WORKER/api/push/test"
```

Cara membaca hasil:

| Gejala | Artinya | Cek |
|---|---|---|
| `watcher.configured` false / `last_error: exness-not-configured` | Secret Exness belum lengkap | `wrangler secret list` |
| `watcher.connected` false / `tickAgeSec` besar | WebSocket Exness putus | `last_error`, `reconnects`, log Worker |
| `watcher.zones` 0 / `zones-unavailable` atau `zones-stale` | Zona tidak sampai / basi di D1 | `GET /api/zones`, log MT5 `ZONA WEB \|`, pastikan `ZoneApiKey` EA terisi |
| `last_fire` ada tapi `last_push.sent` 0 | Zona terdeteksi, push gagal terkirim | `last_push.failed`, `last_push.codes`; 403 semua = VAPID mismatch |
| `last_fire` tidak ada padahal harga menyentuh | Gagal deteksi | Zona `FRESH`? Simbol akun bersuffix? Harga sisi zona vs batas? |
| `subscribers` 0 | Tidak ada HP yang subscribe | Klik NOTIF HP di PWA, cek permission browser |

Catatan:

- `HTTP 200` dari `/api/zones` hanya berarti snapshot EA diterima, bukan berarti
  push terkirim. Periksa `sent` pada `/api/push/test` / `/api/push/status`.
- Endpoint monitoring yang benar adalah `GET /api/push/status`
  (bukan `/api/push/monitor` — endpoint itu tidak ada dan akan 404).
- Tick yang terjadi saat WebSocket putus tidak bisa diputar ulang oleh stream.
- Zona hanya memicu alert kalau statusnya `FRESH` dan bias `BUY`/`SELL`
  (zona `WAIT`/`INVALID` tidak memicu alert).

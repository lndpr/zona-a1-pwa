# ZONA A1 — Exness WebSocket langsung di Cloudflare (tanpa VPS)

Project ini mempertahankan frontend/dashboard PWA dan alur subscriber Web Push. Harga untuk trigger zona BR1/BR2 berasal **hanya dari Exness Trading API WebSocket** yang dikelola Cloudflare Durable Object `TickWatcher`. Tidak ada polling harga BiQuote dan tidak ada fallback harga.

## Arsitektur
EA -> `POST /api/zones` (snapshot zona disimpan di D1) -> Worker membangunkan `TickWatcher` -> Durable Object melakukan DNS Gateway discovery + signed WebSocket GET ke Exness -> subscribe `ticks` XAUUSD -> evaluasi setiap tick -> Web Push.

Cloudflare Cron per menit hanya watchdog/bootstrap koneksi; Cron tidak mengambil harga dan tidak mengirim trigger berdasarkan polling.

## 1. Persiapan Exness
Buat API Key di Exness Personal Area dan pastikan akun memenuhi eligibility Exness API. Siapkan:
- API key identifier
- Private key (format 128 hex dari Exness atau PKCS#8 PEM yang didukung kode)
- Account ID
- DNS Gateway host dari Exness API Key Management

Nama instrumen harus persis sesuai akun. Default `XAUUSD`; akun tertentu mungkin menggunakan suffix seperti `XAUUSDm`. Pastikan dari daftar instrumen akun Exness.

## 2. Konfigurasi Cloudflare
Dari folder `worker`, jalankan:

```powershell
npx wrangler secret put EXN_API_KEY
npx wrangler secret put EXN_PRIVATE_KEY
npx wrangler secret put EXN_ACCOUNT_ID
npx wrangler secret put EXN_GATEWAY_URL
npx wrangler secret put API_SECRET
npx wrangler secret put ADMIN_SECRET
npx wrangler secret put VAPID_PUBLIC
npx wrangler secret put VAPID_PRIVATE_JWK
npx wrangler secret put PUSH_ADMIN_TOKEN
npx wrangler deploy
```

`EXN_GATEWAY_URL` adalah host HTTPS Gateway DNS Exness, bukan Access Point akun. Durable Object akan menandatangani request discovery dan menyimpan Access Point hasil discovery selama 6 jam. Jika ingin memasang Access Point langsung, gunakan `EXN_ACCESS_POINT` sebagai Worker secret/var sesuai kebutuhan dan jangan set gateway jika tidak diperlukan.

Pertahankan D1 `DB` dan `SIGNAL_HUB` yang sudah ada. Binding `TICK_WATCHER` dan migration `v2` sudah ditambahkan ke `wrangler.toml`. Jika project Cloudflare sudah pernah memakai migration tag `v2` untuk class lain, jangan deploy sebelum menyesuaikan tag migration agar unik dan berurutan.

## 3. Deploy
```powershell
cd worker
npx wrangler deploy
```

Setelah deploy, kirim snapshot zona dari EA ke `/api/zones`. Handler akan memanggil TickWatcher `/refresh`, yang juga mencoba bootstrap koneksi Exness.

## 4. Monitoring
Cek status dengan admin token:
```powershell
curl.exe -H "X-Admin-Token: TOKEN_PUSH_ADMIN" https://DOMAIN-WORKER/api/push/status
```
Periksa `watcher.configured`, `watcher.connected`, `watcher.tickAgeSec`, `watcher.bid`, `watcher.ask`, `watcher.last_error`, `watcher.reconnects`, `watcher.zones`, `watcher.last_fire`, dan `watcher.last_push`.

Tes push subscriber:
```powershell
curl.exe -X POST -H "X-Admin-Token: TOKEN_PUSH_ADMIN" https://DOMAIN-WORKER/api/push/test
```

## Perilaku dan batasan
- Tidak ada VPS dan tidak ada service Node.js lokal.
- Tidak ada BiQuote sebagai sumber harga atau fallback trigger.
- Exness ticks menyediakan Bid/Ask; update dapat di-throttle hingga sekitar 500 ms oleh Exness.
- Saat koneksi terputus, DO reconnect dengan backoff dan resubscribe. Tick yang terjadi saat offline tidak bisa diputar ulang oleh stream.
- `HTTP 200` dari `/api/zones` hanya berarti snapshot EA diterima, bukan berarti push terkirim.
- `HTTP 200` dari `/api/push/test` dan jumlah `sent` harus diperiksa untuk memastikan delivery ke browser.
- Cloudflare Durable Object WebSocket memiliki biaya durasi saat koneksi aktif; cek usage/billing Cloudflare setelah berjalan.

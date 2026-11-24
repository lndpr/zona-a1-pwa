# ZONA A1 — Deploy peningkatan notifikasi

## Yang berubah
- BiQuote tetap menjadi sumber harga XAUUSD.
- Durable Object alarm memeriksa harga sekitar setiap 3 detik; Cron satu menit hanya memastikan monitor aktif.
- Event trigger dan status delivery dipisah di D1.
- Delivery queue melakukan retry exponential backoff hingga 8 percobaan.
- Subscriber mati (HTTP 404/410) otomatis dihapus.
- Endpoint monitoring: `GET /api/push/monitor` dengan header `X-Admin-Token`.
- Tes push: `POST /api/push/test` dengan header `X-Admin-Token`.

## Deploy
Jalankan PowerShell dari folder `worker`:

```powershell
npx wrangler deploy
```

Pastikan secret `VAPID_PUBLIC`, `VAPID_PRIVATE_JWK`, `PUSH_ADMIN_TOKEN`, serta `ZONES_API_KEY` tetap tersedia di Cloudflare. D1 binding dan Durable Object binding yang lama dipertahankan.

## Cek monitoring

```powershell
curl.exe -H "X-Admin-Token: TOKEN_ADMIN_ANDA" "https://zona-a1-signal-api.landungprakoso14.workers.dev/api/push/monitor"
```

Tes push:

```powershell
curl.exe -X POST -H "X-Admin-Token: TOKEN_ADMIN_ANDA" "https://zona-a1-signal-api.landungprakoso14.workers.dev/api/push/test"
```

Polling 3 detik adalah target. Karena sumbernya BiQuote API (bukan stream tick), lonjakan harga yang seluruhnya terjadi di antara dua polling masih berpotensi tidak teramati.

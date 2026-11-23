# ZONA A1 PWA — Changelog Perbaikan (19 Nov 2026)

Semua temuan audit `ZONA-A1-PWA-AUDIT.md` sudah diperbaiki. Zip ini berisi seluruh
repo hasil perbaikan (frontend + Worker + EA). File ini ikut di dalam zip.

## Notif zona baru tidak lagi berulang — sekali per slot, diawal aja (23 Nov 2026)

**Bug yang dilaporkan user, 23 Nov ~22:06 WIB (dengan screenshot):** "2 NEW ZONES · XAUUSD" muncul berulang — 21:01, 21:14, 21:32, 21:45, 21:56, 22:02, 22:06, padahal zonanya sama (M1/M5/M15/H1, tiap beberapa menit). Dicek live di `/api/push/history`: 7 pengumuman "2 NEW ZONES" dalam ~1 jam, sebagian slot yang sama (M1 20:26 → 22:02 → 22:06; M5 21:01 → 21:14 → 21:56).

**Akar masalah:** flush tiap 30 detik MENGHAPUS catatan pengumuman zona yang sedang tidak ada di snapshot (status bukan FRESH / zona keluar snapshot). EA menghitung ulang zona tiap beberapa menit — zona yang sama hilang sebentar (mis. sempat TRIGGERED) lalu muncul lagi, catatannya sudah terhapus, jadi diumumkan lagi sebagai "zona baru". Bukan duplikat kirim yang sama: tiap update zona memicu pengumuman baru.

**Perbaikan (Worker: `worker/src/tick-watcher.js`):**
- Catatan pengumuman TIDAK PERNAH dihapus saat zona keluar dari snapshot — sekali per slot, diawal aja (aturan user 23 Nov ~22:07). Zona yang hilang lalu muncul lagi tidak diumumkan ulang.
- Prune 7 hari (`ANNOUNCE_KEEP_MS`): catatan pengumuman yang sudah > 7 hari dihapus supaya tabel tidak membengkak; slot yang sama baru boleh bunyi lagi setelah itu.
- Pengumuman gagal total tetap retry 60 detik (tidak ditandai, dicoba lagi — yang tidak pernah sampai ke HP tidak dihitung sudah diumumkan).

**Yang tetap jalan:** zona yang benar-benar baru di slot yang belum pernah diumumkan tetap diumumkan sekali di awal. Notif TRIGGERED tidak berubah (sekali per zona sampai ada zona baru — baris trigger tetap di-flush saat zona keluar snapshot).

Verifikasi: harness Node menjalankan TickWatcher ASLI dengan D1 palsu (32/32 lolos, termasuk 6 skenario pengumuman) — zona baru diumumkan 1x, reload berikutnya tidak ulang, zona hilang >3 menit lalu balik FRESH tidak diumumkan ulang, setelah 8 hari diumumkan lagi sekali.

**Deploy:** `npx wrangler deploy` (Worker saja; frontend tidak berubah di ronde ini).

## Notif TRIGGERED tidak lagi ganda — sekali per zona (23 Nov 2026)

**Bug yang dilaporkan user, 23 Nov ~20:35 WIB (dengan screenshot):** zona M1 yang sama mengirim notif TRIGGERED berkali-kali — BR2 3x (20:33:03, 20:33:16, 20:33:41) dan BR1 2x (20:34:05, 20:34:45), padahal harga cuma turun sekali melewati zona. Dicek live di `/api/push/history`: 5 push trigger dalam ~100 detik.

**Akar masalah:** reset trigger menghapus baris state di D1 (`deleteTriggerStmt`). Batas reset cuma 0,5 USD — harga M1 gampang wick keluar-masuk selebar itu (apalagi saat spread melebar). Begitu harga keluar sebentar, baris state terhapus; begitu harga balik masuk, zona dianggap "baru" (`isNew` → `fresh`) dan langsung fire lagi. Dua jalur trigger (TickWatcher + POST EA) sama-sama lolos karena keduanya mengandalkan baris yang sudah dihapus itu.

**Perbaikan (hanya Worker: `worker/src/push-alerts.js` + `worker/src/tick-watcher.js`):**
- Sekali per zona, tanpa re-arm dan tanpa cooldown (aturan user 23 Nov ~20:50): zona yang sudah bunyi tidak pernah bunyi lagi selama baris state-nya masih ada di D1 — reset keluar zona dihapus total. Baris hanya hilang lewat flush saat zona keluar dari snapshot (>3 menit); zona BARU dengan key yang sama baru boleh bunyi lagi sekali.
- TickWatcher mengecek ulang D1 tepat sebelum kirim push (jalur EA bisa saja sudah fire di antara reload 5 detik).
- Jalur POST EA: zona yang sudah triggered ditolak dengan `already-triggered`.

**Yang tetap jalan:** sentuhan pertama tetap langsung bunyi; zona baru (zona lama hilang dari snapshot >3 menit, lalu terbentuk lagi) bunyi sekali. Kalau push gagal total, retry 60 detik tetap jalan (baris dihapus supaya sentuhan itu bisa dicoba lagi — sengaja, supaya tidak kehilangan alert; yang tidak pernah sampai ke HP tidak dihitung sudah bunyi).

Verifikasi: harness Node menjalankan TickWatcher + handleZoneTrigger ASLI dengan D1 palsu, replay urutan live 20:33 (26/26 lolos) — wick kecil tidak fire, keluar jauh + balik masuk tidak pernah fire lagi, POST EA setelah fire ditolak (juga setelah 16 menit), zona baru setelah zona lama hilang >3 menit fire sekali, race EA+TickWatcher tidak double-fire.

**Deploy:** `npx wrangler deploy` (Worker saja; frontend tidak berubah di ronde ini — perbaikan `sw.js` ronde sebelumnya tetap ada di zip ini).

## Teks fallback notifikasi push diperbaiki (23 Nov 2026)

**Bug yang dilaporkan user, 23 Nov ~20:28 WIB:** zona baru M1 (BUY BR1/BR2) muncul, tapi notifikasi di HP berbunyi "Harga masuk area blok BR1/BR2. Buka ZONA A1 untuk detail." — padahal Worker sudah mengirim "2 NEW ZONES · XAUUSD" dengan benar (terkirim ke 25 subscriber; dicek live di `/tick-watcher/status` + `/api/push/history` + dashboard — zona M1 masih FRESH, tidak ada trigger).

**Akar masalah:** push yang dikirim Worker itu KOSONG (tanpa isi — `sendOne` hanya POST dengan header VAPID). Service worker di HP lalu mengambil isi asli dari `GET /api/push/last` dengan timeout 3,5 detik, sekali percobaan. Kalau fetch itu gagal/kelamaan (sinyal HP lemot), SW menampilkan teks cadangan yang di-hardcode di `frontend/sw.js` — dan teks cadangan itu menyebut kejadian spesifik yang salah ("Harga masuk area blok BR1/BR2") untuk SEMUA jenis alert (zona baru, trigger, news, tes).

**Perbaikan (hanya `frontend/sw.js`):**
- Teks cadangan diganti netral: "Ada alert baru dari ZONA A1. Buka dashboard untuk detail." — tidak akan pernah mengaku-aku kejadian yang salah lagi.
- Fetch isi asli: 2x percobaan, timeout 8 detik tiap percobaan (dulu 1x, 3,5 detik), supaya teks cadangan makin jarang muncul.

Verifikasi: harness Node menjalankan `sw.js` asli dengan stub (11/11 lolos) — fetch sukses di percobaan pertama → isi asli tampil; fetch gagal dulu lalu sukses di retry → isi asli tampil; fetch selalu gagal → fallback netral, teks lama tidak pernah muncul. `node --check frontend/sw.js` bersih.

**Catatan:** perbaikan penuh (isi alert ikut terkirim DI DALAM push, tanpa perlu fetch lagi) butuh enkripsi payload Web Push + menyimpan kunci `p256dh`/`auth` tiap subscriber — saat ini `push_subs` hanya menyimpan `endpoint`, jadi semua subscriber harus subscribe ulang. Ditunda; perbaikan di atas sudah menutup teks yang menyesatkan. Setelah deploy frontend, tutup-buka sekali PWA di HP supaya service worker baru terpasang.

## Halaman Fasilitas dihapus (23 Nov 2026)

- File `frontend/rebate.html` ("Rebate Sharing") **dihapus** — itu halaman yang
  dibuka menu "Fasilitas" (file `fasilitas.html` sendiri sudah tidak ada sejak
  perbaikan 19 Nov; link-nya dulu dialihkan ke `rebate.html`).
- Semua link ke halaman itu dihapus: menu desktop + mobile + tautan info di
  `index.html` (label "Fasilitas"), menu desktop + mobile di `upgrade.html`
  (label "Upgrade Plan" — link yang sama). Menu lain utuh (Dashboard, Signals,
  Intelligence, Info Member/Tools, E-Book).
- CSS khusus link tersebut (`.rebate-link`, `.mobile-rebate`) dibersihkan dari
  `index.html`, `upgrade.html`, `ebook.html`, `matary-trading-system.html`;
  entri kamus i18n `"Fasilitas"` di `index.html` ikut dihapus. Service worker
  tidak pernah men-cache halaman ini, jadi tidak ada perubahan di `sw.js`.
- Yang **tetap ada**: bagian "Fasilitas" di dalam halaman Upgrade
  (`upgrade.html`, section `#fasilitas` — "Indikator & EA"). Itu isi halaman
  Upgrade sendiri, bukan halaman terpisah. Kalau bagian itu juga mau dihapus,
  tinggal bilang.

Verifikasi: `grep -ri rebate frontend/` kosong; serve lokal — `index.html`,
`upgrade.html`, `ebook.html`, `matary-trading-system.html` 200, `rebate.html`
404, tidak ada lagi kata "Fasilitas" di `index.html`.

## Notifikasi news 15 menit sebelum rilis (23 Nov 2026)

Sebelumnya tidak ada notifikasi push untuk news — yang ada hanya countdown
"next event" di halaman web (event tetap tampil sampai 15 menit SETELAH jam
rilisnya). Sekarang ada push beneran, dari cron tiap menit yang sudah ada
(`wrangler.toml`: `* * * * *` — tidak perlu cron baru):

- **Sumber data:** kalender yang sama dengan yang tampil di web — BiQuote
  `.../api/calendar/upcoming?limit=40&countries=US,EU,GB,JP,ID&importance=high`
  (sudah difilter high di server). Cron fetch paling cepat tiap 5 menit (cache
  D1 `news_cache`); kalau fetch gagal, pakai cache lama; kalau tidak ada cache,
  lewati menit itu.
- **Filter:** hanya **high-impact + mata uang USD** (currency `USD` atau
  countryCode `US`). EUR/GB/JP/ID dari API yang sama sengaja tidak diumumkan —
  penggerak XAUUSD adalah USD. Kalau mau diperluas, ubah filter currency di
  `parseNewsEvents()` (`worker/src/push-alerts.js`).
- **Waktu:** alert saat rilis masuk jendela (0, 15 menit] — cron yang kelewat
  1 menit tetap mengirim (terlambat sedikit lebih baik daripada tidak sama
  sekali). Jam tampil di **WIB** (`Asia/Jakarta`).
- **Sekali per event:** dicatat di D1 `news_alert_state` (key = jam rilis +
  nama event); baris lama dihapus otomatis. Kalau kirim gagal total, TIDAK
  ditandai — cron menit berikutnya mencoba lagi (pola yang sama dengan
  pengumuman zona baru). Kalau tidak ada subscriber, ditandai (tidak ada yang
  bisa dikirimi).
- **Isi notif:** 1 rilis → judul `NEWS USD — Core CPI m/m`, isi `Rilis Core CPI
  m/m (USD) 15 menit lagi, pukul 19:30 WIB. Pantau XAUUSD — volatilitas biasa
  naik saat rilis.` Kalau 2+ rilis dalam satu jendela → 1 push berisi daftar
  semuanya (`2 NEWS USD · 15 MENIT LAGI`). Tag `a1-news-<timestamp>`, masuk
  juga ke riwayat `push_history` (inbox "ALERT TERAKHIR").
- **Diagnosa:** `GET /api/push/status` (admin) kini mengembalikan
  `last_news_alert` (nama rilis + jam event + kapan diumumkan). Cron tidak mati
  kalau fetch kalender gagal — error dicatat di log Worker dan watchdog
  Exness tetap jalan.
- **Yang TIDAK dilakukan:** tidak ada notifikasi hasil rilis (actual vs
  forecast) — itu tetap tampil di halaman web seperti sebelumnya
  (`loadCalendarResults`), bukan push.

Verifikasi (harness Node, mock D1 + stub fetch kalender): **21/21 lolos** —
alert saat 14 menit lagi (judul/body/WIB/tag), tidak duplikat menit berikut,
16 menit belum alert → 14 menit alert, filter medium/EUR/lewat/tanpa-waktu,
gagal kirim tidak ditandai + retry + sukses ditandai, cache 5 menit (2 cek =
1 fetch), 2 rilis jadi 1 push, parse epoch detik/countryCode/kapital, cron
tetap jalan walau fetch kalender gagal. `node --check` lolos. Belum dites live
(butuh `wrangler deploy` + satu rilis USD high-impact sungguhan).

## Keamanan — kritis + quick win (20 Nov 2026)

**WAJIB DILAKUKAN USER (kunci lama sudah bocor di repo publik):**
1. Di PowerShell, dari folder `worker`: `npx wrangler secret put API_SECRET`
   lalu tempel kunci BARU 64 karakter heksadesimal yang dibuat untuk sir (dikirim
   terpisah di chat — JANGAN commit kunci itu ke repo, dan jangan pakai lagi nilai
   lama). Sampai langkah ini selesai, sinyal dari EA akan ditolak Worker (401).
2. Di MetaEditor: isi input EA `SignalApiKey` dengan kunci baru yang SAMA, lalu
   compile + attach ulang. `SignalApiKey` di file ini sekarang default KOSONG dan
   EA menolak kirim sinyal kalau kosong (peringatan di OnInit) — sama seperti
   `ZoneApiKey` selama ini. Kunci lama di git history sudah tidak berguna setelah
   secret diganti; rewrite history (git filter-repo) opsional.
3. `cd worker && npx wrangler deploy` (deploy ulang Worker berisi perbaikan di bawah).

Yang diubah di kode:
- **EA `A1_new.mq5`:** `SignalApiKey` default `""` (dulu berisi nilai default yang
  ter-commit di repo publik — siapa pun bisa POST sinyal palsu ke `/api/signal`
  kalau secret Worker masih sama dengan nilai itu). Guard `SignalApiKey==""` di
  `SendSignalToWeb` + `SendCloseSignalToWeb`, peringatan OnInit. Logika trading
  tidak disentuh.
- **Rate limit berbasis D1** (`rateLimitCheck()` di `push-alerts.js`, tabel baru
  `rate_limits`, kunci per IP + endpoint, jendela 60 detik, balasan 429 +
  header `Retry-After`): `POST /api/push/subscribe` 5/menit/IP (tanpa ini,
  penyerang bisa memenuhi kuota 2.000 langganan dengan endpoint sampah dan user
  asli ditolak), `POST /api/zones` 30/menit/IP, `POST /api/zones/trigger`
  60/menit/IP, `POST /api/signal` 60/menit/IP. Dicek SEBELUM auth supaya banjir
  tidak membebani D1. Batas ini longgar untuk EA (heartbeat 60 dtk, sinyal hanya
  saat entry/close) — pemakaian normal tidak akan kena. Untuk batas keras di
  level edge, tambah juga WAF Rate Limiting Rule di dashboard Cloudflare untuk
  path `/api/*` (opsional, lihat `NOTIFICATION-DEPLOY.md`).
- **Security headers** di semua respons JSON Worker (`push-alerts.js`,
  `zones-endpoint.js`, `index.js`): `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Strict-Transport-Security`, CSP `default-src 'none'; frame-ancestors 'none'`.
  Catatan: halaman frontend di GitHub Pages TIDAK bisa diset header-nya (Pages
  tidak mendukung custom header) — ini menutup sisi Worker saja.
- **Perbandingan kunci tanpa early-exit** (`safeEqual()`): dipakai di
  `X-API-Key` (zones/trigger/signal), `X-Admin-Token`, dan `X-Admin-Key`.
- Masih disengaja / belum diubah: CORS `Allow-Origin: *` (auth pakai header,
  bukan cookie, jadi CSRF tidak bisa memalsukan kunci — risikonya kecil);
  `GET /api/zones`, `/api/push/last`, `/api/push/history`, `/tick-watcher/status`
  tetap publik (isi: zona + riwayat alert, tanpa data pribadi/uang);
  CDN frontend (TradingView, Google Fonts, Font Awesome) masih tanpa SRI —
  butuh hash per file dan tidak bisa dipasang untuk script TradingView yang
  dinamis; mitigasi jangka panjang: pindah frontend ke Cloudflare Pages +
  `_headers` + CSP.

Verifikasi (harness Node, mock D1): **19/19 lolos** — safeEqual (sama/beda/beda
panjang/non-string), rate limit (5 lolos ke-6 ditolak, IP lain tidak terpengaruh,
jendela baru boleh lagi), subscribe 5 lolos ke-6 kena 429 + header Retry-After +
header keamanan + kuota tidak terisi banjir, zones kunci 1 char beda → 401,
kunci benar → 200, zones 30 lolos ke-31 kena 429. `node --check` lolos untuk
`push-alerts.js`, `zones-endpoint.js`, `index.js`, `tick-watcher.js`; EA brace/
parens seimbang. Belum dites live (butuh `wrangler deploy` + rotasi secret).

## Yang diperbaiki — Notifikasi (penyebab "kadang muncul kadang enggak")

1. **Route `/api/zones/trigger` dibuat** (`worker/src/index.js`, `worker/src/push-alerts.js`
   `handleZoneTrigger`). Dulu EA POST ke endpoint ini dan selalu dapat 404. Sekarang:
   auth `X-API-Key` = `ZONES_API_KEY`/`API_KEY`, validasi payload, cocokkan dengan zona
   aktif (FRESH + harga di dalam batas). Zona tidak aktif / sudah triggered → HTTP 200
   dengan `reason` (bukan error, supaya EA berhenti retry tiap 5 detik). Fire → push
   dikirim dan TickWatcher di-`refresh` supaya langsung sinkron.
2. **Zona bisa berbunyi lagi** (`worker/src/tick-watcher.js`). Dulu sekali trigger,
   tidak pernah lagi. Sekarang kalau harga sisi zona keluar dari `[lo − 0.5, hi + 0.5]`
   USD, flag trigger dihapus (memori + D1) dan zona boleh fire lagi pada sentuhan
   berikutnya.
3. **Push gagal tidak lagi hilang diam-diam.** Kalau `sendAll()` gagal total padahal
   ada subscriber (`sent == 0 && failed > 0`), flag trigger dilepas + baris D1 dihapus
   dan dicoba lagi setelah jeda 60 detik (`retryAfter`). Sukses tetap seperti dulu.
4. **Harga sisi zona, bukan mid.** BUY dicek pakai `bid`, SELL pakai `ask` (dulu mid —
   selisih setengah spread dari harga yang dipakai EA). `prev` juga dipisah
   per sisi (prevBid/prevAsk/prevMid).
5. **Tick pertama setelah restart DO bisa fire.** Dulu `prev = null` + `first = false`
   membuat sentuhan saat restart terlewat. Sekarang `first` juga true saat `prevMid`
   null (harga sudah di dalam zona saat DO bangun → langsung fire).
6. **Service Worker didaftarkan saat halaman dimuat** (`frontend/js/pwa-init.js` —
   sekarang satu-satunya tempat registrasi). Dulu SW hanya terdaftar saat tombol
   NOTIF HP diklik. `enable()` di `index.html` sekarang memakai registrasi yang ada.
7. **Path PWA relatif** (manifest `id`/`start_url`/`scope` = `"./"`, ikon `"./assets/..."`,
   `sw.js` + ikon/badge notifikasi relatif). Dulu path absolut `/...` pecah di project
   Pages `lndpr.github.io/zona-a1-pwa/` (CNAME kosong) sehingga PWA tidak bisa
   di-install — di iPhone push mustahil tanpa PWA ter-install. Tambah ikon `maskable`.
8. **Validasi subscription vs VAPID** (`index.html`). Key VAPID disimpan di
   `localStorage "a1_vapid_key"`; kalau key server berubah → unsubscribe lama, subscribe
   baru. Kalau `/api/push/key` gagal (mis. 503) → tampilkan pesan `MSG.server` yang
   benar, bukan error mentah. `boot()` sekarang auto-resubscribe kalau permission
   sudah granted tapi subscription hilang (dulu diam saja, state tetap OFF).
9. **Tag notifikasi unik per alert** (`"a1-zone-" + timestamp`, dulu satu tag `"a1-zone"`).
   Tiga trigger berurutan tidak lagi saling menimpa jadi satu notifikasi.
10. **TTL push 600 → 3600 detik** (1 jam). HP Doze/offline >10 menit tidak lagi membuat
    push langsung dibuang.
11. **Riwayat alert + inbox mini.** Server menyimpan `push_history` (maks 50) dan
    menyediakan `GET /api/push/history` (20 terbaru, publik). Halaman menampilkan
    "ALERT TERAKHIR" (maks 5) di bagian zona live; gagal/kosong → bagian disembunyikan.
12. **Subscription 403 dibersihkan secara selektif.** Dulu hanya 404/410 yang dihapus.
    Sekarang 403 dihapus kalau ada endpoint lain yang sukses (403-nya spesifik ke
    subscription itu). Kalau SEMUA gagal 403 → tidak ada yang dihapus + log
    `VAPID_MISMATCH_SUSPECTED` (kemungkinan VAPID salah).
13. **`pushsubscriptionchange` di `sw.js`.** Browser me-rotate subscription → SW
    subscribe ulang + POST ke `/api/push/subscribe` otomatis.
14. **Normalisasi simbol.** `XAUUSDm`/`XAUUSDc` → `XAUUSD` untuk penyimpanan & lookup
    zona (`baseSymbol()` di `push-alerts.js`, dipakai `zones-endpoint.js` dan
    `loadActiveZones`). Subscribe WebSocket Exness tetap memakai simbol persis akun.
15. **Merge snapshot per TF + chart.** `zones-endpoint.js` merge key `tf` → `tf|chart_id`;
    EA sekarang mengirim `chart_id` di snapshot, jadi dua chart tidak saling menimpa.
16. **Petunjuk install iPhone.** `pwa-init.js` menampilkan bilah "Share → Add to Home
    Screen" kalau `beforeinstallprompt` tidak ada (iOS) dan belum standalone.
17. **Toast in-page 3 → 10 menit** (jendela `now - at < 600000`).

## Tambahan — Notifikasi zona baru FRESH (20 Nov 2026)

Sebelumnya fungsi `commitNewZoneAndPush()` ada tapi **tidak pernah dipanggil** — zona
baru hanya muncul di dashboard tanpa bunyi. Sekarang sudah disambungkan:

- `TickWatcher.reloadZones()` mengumumkan zona FRESH yang pertama kali dilihat:
  judul `NEW ZONE BUY M1 · BR1` (tag `a1-new-zone-<timestamp>`), isi daftar zona
  baru + "Pantau area dan tunggu konfirmasi sebelum entry." Masuk juga ke riwayat
  `push_history` sehingga tampil di inbox "ALERT TERAKHIR" di halaman.
- **Sekali per zona:** dicatat persisten di D1 `zone_announcement_state`, jadi DO
  restart tidak mengumumkan ulang. Kalau zona hilang dari snapshot, catatannya
  dihapus (saat flush 30 detik) dan zona yang sama boleh diumumkan lagi saat
  terbentuk kembali.
- **Gagal kirim = dicoba lagi:** kalau `sendAll()` gagal total padahal ada subscriber,
  zona tidak ditandai announced dan dicoba lagi setelah jeda 60 detik
  (`announceRetryAfter`). Syarat pengumuman sengaja memakai catatan D1 (bukan flag
  `isNew` sekali-pakai) — kalau memakai `isNew`, retry tidak akan pernah terjadi
  karena baris `seenStmt` membuat `isNew` false pada reload berikutnya. Ini ketahuan
  saat pengujian dan sudah diperbaiki.
- **Status:** pengumuman terakhir terlihat di `GET /tick-watcher/status` →
  `last_announce` (juga didokumentasikan di `NOTIFICATION-DEPLOY.md` + `README.md`).
- Catatan perilaku: kalau harga sudah berada di dalam zona baru itu, notif TRIGGERED
  bisa menyusul beberapa detik kemudian dari `process()` — itu dua kejadian berbeda
  (zona terbentuk + harga menyentuh), bukan duplikat. Pengumuman butuh TickWatcher
  berjalan (snapshot masuk via `/refresh` + ada tick); kalau WebSocket Exness mati
  total dan belum ada tick sama sekali, pengumuman ikut tertunda seperti halnya trigger.

Verifikasi tambahan (harness Node, mock D1 + DO palsu, kirim push di-stub gagal 400):
**16/16 lolos** — announce sekali (2 blok, tag unik, tercatat di D1); reload kedua
tidak duplikat; zona hilang + muncul lagi diumumkan lagi; gagal kirim tidak ditandai
announced + retry dijadwalkan 60 detik; tidak mencoba lagi dalam masa retry; mencoba
lagi setelah retry kadaluarsa; announce + trigger berdampingan dalam satu siklus;
restart DO tidak mengumumkan ulang yang sudah announced; zona belum announced tetap
diumumkan setelah restart. `node --check` lolos untuk `tick-watcher.js` +
`push-alerts.js`. Seperti sebelumnya: belum dites live.

## Yang diperbaiki — EA (`A1_new.mq5`)

- Throttle snapshot hanya dihitung dari kirim yang **berhasil** (HTTP 200). Dulu
  timestamp di-set sebelum `WebRequest`, jadi sekali gagal EA diam 60 detik dan zona
  cepat basi. Sekarang gagal → retry setelah 10 detik (`g_lastZoneSnapshotFailTime`).
- Snapshot JSON kini memuat `"chart_id"` (dari `ChartID()`).
- `OnInit()` mencetak peringatan jelas kalau `ZoneApiKey` kosong.
- Tidak ada perubahan logika trading/zona/entry/SL/TP. **Belum dikompilasi di
  MetaEditor — user harus compile sendiri.**

## Yang diperbaiki — Frontend / repo lainnya

- **Bug cache navigasi** (`sw.js`): respons halaman disimpan di bawah `request.url`
  aslinya, bukan hardcode ke `/index.html` + `/`. Offline fallback: halaman yang
  diminta → `./index.html` → `./offline.html`. Cache version `zona-a1-pwa-v4`.
- **Link mati:** `fasilitas.html` → `rebate.html` (index + upgrade), `panduan.html` →
  `ebook.html`.
- **Tombol download PDF ebook** (6 link, file PDF tidak ada) → halaman pelajaran HTML
  masing-masing, atribut `download` dihapus. Tombol hero jadi "BACA E-BOOK".
- **`EA_DOWNLOAD_URL`** diisi URL raw GitHub `A1_new.mq5` dan disambungkan ke tautan
  "Download EA (.mq5)" di footer zona live.
- **Manifest + `pwa-init.js`** ditambahkan ke 9 halaman selain `index.html`.
- **Deduplikasi:** hapus duplikat `theme-color`; `og:url` → `https://lndpr.github.io/zona-a1-pwa/`.
- **Aksesibilitas:** `<noscript>` di `index.html`, `aria-label` pada pencarian ebook,
  teks mikro statistik zona 7.5px → 10px.
- **File yatim dihapus** (sudah grep, nol referensi): `css/style.css`,
  `css/style - Copy.css`, `css/hero.css`, `css/hero/hero.html`,
  `zona-chart-engine.js`, `rebuild.txt`, `assets/ea.png`, `assets/indicator.png`.
- **Duplikat/backup Worker dihapus:** `worker/src/sw.js`, 7 file `* backup.js` /
  `* - Copy.js`, `worker/wrangler backup.toml`.
- **Worker masuk version control:** baris `/worker/` dihapus dari `.gitignore`
  (`.wrangler/` tetap di-ignore).
- **Dokumen ditulis ulang:** `worker/NOTIFICATION-DEPLOY.md` (tanpa BiQuote/polling,
  endpoint benar `/api/push/status`, route trigger, reset, retry, TTL, simbol) dan
  bagian terkait di `README.md`.
- Catatan: `deploy.yml` hanya berubah line ending (CRLF → LF), isinya identik.

## Verifikasi yang dilakukan (bukan tes live)

- `node --check` lolos untuk semua file JS Worker (`index`, `push-alerts`,
  `tick-watcher`, `zones-endpoint`, `signal-hub`) dan frontend (`sw.js`, `pwa-init.js`).
- **Harness fungsional Node (mock D1, tanpa network): 19/19 lolos** — snapshot
  `XAUUSDm` tersimpan di bawah `XAUUSD` + `chart_id` dipertahankan; `parseZones` key
  memakai `chart_id`; trigger pertama `fired` + baris trigger memakai key chart_id
  (bukan `tf|tf`); trigger kedua → `already-triggered`; harga di luar zona →
  `zone-not-active` (200); API key salah → 401; `shouldFire` BUY/SELL lintasan +
  first-inside.
- **Satu bug antar-perbaikan ketahuan & diperbaiki saat verifikasi:** `handleZoneTrigger`
  awalnya membangun key `${tf}|${tf}|...`, padahal sejak EA mengirim `chart_id` key
  TickWatcher adalah `${chart_id}|${tf}|...` — sudah diperbaiki memakai `z.key` dari
  `parseZones` (harness di atas membuktikannya).
- Serve lokal frontend: `index.html`, `manifest.webmanifest`, `sw.js`, `ebook.html`,
  `offline.html`, `rebate.html`, `upgrade.html`, `js/pwa-init.js`, ikon — semua HTTP 200;
  manifest JSON valid (path relatif + maskable); grep akhir: 0 referensi
  `fasilitas.html`/`panduan.html`/`.pdf`, 0 path absolut PWA.
- Keseimbangan kurung `A1_new.mq5`: `{` 175/175, `(` 945/945, `[` 256/256.
- **Belum dites live:** tidak ada `wrangler deploy`, push sungguhan (VAPID/FCM/APNS),
  koneksi WebSocket Exness live, atau uji install PWA di HP. Itu langkah user di bawah.

## Cara deploy (urutan)

1. Backup repo lokal dulu. Extract zip ini menimpa repo (atau copy file yang berubah),
   lalu `git add -A && git commit && git push` — workflow Pages men-deploy frontend
   otomatis. (Worker TIDAK ikut workflow; langkah 2.)
2. `cd worker && npx wrangler deploy` — tidak ada secret baru yang dibutuhkan
   (semua secret lama tetap dipakai). Tabel `push_history` dibuat otomatis saat
   runtime pertama (`ensureSchema`).
3. EA: buka `A1_new.mq5` di MetaEditor → Compile → periksa tab Errors → attach ke
   chart. Isi input `ZoneApiKey` dengan nilai yang sama seperti secret `ZONES_API_KEY`
   di Worker (kalau kosong, EA sekarang mencetak peringatan di Experts).
4. Di HP: hapus install PWA lama kalau ada, buka situs, install lagi (iPhone: Share →
   Add to Home Screen), lalu ketuk NOTIF HP sekali untuk subscribe ulang di bawah
   logika baru. (Subscription lama di D1 tetap ada; yang mati akan dibersihkan
   otomatis oleh aturan 403/404/410.)
5. Tes push: `POST /api/push/test` dengan header `X-Admin-Token: <PUSH_ADMIN_TOKEN>` —
   harus ada `sent >= 1`. Lalu cek `GET /api/push/status` (admin) dan
   `GET /tick-watcher/status` (publik): `configured: true`, `connected: true`,
   `tickAgeSec` kecil, `zones > 0`. Tunggu satu sentuhan zona dan cek `last_fire` vs
   `last_push` (sent/failed/codes) untuk membedakan deteksi vs pengiriman.
6. Kalau satu zona sudah berbunyi lalu harga keluar-masuk lagi, notifikasi harus
   berbunyi lagi (reset 0.5 USD) — itu perilaku baru yang dulu tidak ada.

## Peringatan / yang masih perlu perhatian user

- Ada API key default yang ter-commit di `A1_new.mq5` (input SignalApiKey) dan di repo
  git — sebaiknya dirotasi (ganti secret Worker + input EA), jangan dibiarkan sebagai
  default publik. Nilai key tidak ditulis di file ini.
- Kalau nanti dipakai custom domain (`zonaa1.matary.id`), isi `frontend/CNAME` dengan
  domain itu + atur DNS; path relatif di perbaikan ini jalan di kedua host, jadi
  tidak wajib. `og:url` saat ini menunjuk `lndpr.github.io/zona-a1-pwa/`.
- `GET /api/push/history` dan `/api/push/last` publik tanpa auth (sama seperti
  sebelumnya) — isinya hanya judul/body alert, bukan data sensitif.

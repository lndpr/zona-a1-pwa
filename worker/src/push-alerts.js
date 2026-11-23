// push-alerts.js — Web Push alert zona ZONA A1 (Cloudflare Worker, module syntax)
//
// Dipakai dari Worker zona-a1-signal-api (src/index.js):
//   - handlePush(request, env)  -> Response | null   (endpoint /api/push/*)
//   - runPushAlerts(env)                              (dipanggil dari cron tiap menit)
//
// ALUR BARU:
//   * Deteksi utama = Durable Object TickWatcher (tick-watcher.js) yang menahan WebSocket ticks
//     Exness 24/7 -> alert terkirim dalam hitungan detik, bukan nunggu cron.
//   * Cron tiap menit cuma jadi watchdog (nyalain ulang WebSocket) + cek kalender news
//     (alert 15 menit sebelum rilis high-impact USD). Cron TIDAK mengambil harga
//     dan TIDAK pernah mengirim push harga; tidak ada fallback harga (dulu BiQuote, sudah dihapus).
// Zona dibaca dari tabel D1 zone_snapshots (diisi EA lewat /api/zones).
//
// Push dikirim TANPA payload (hanya header VAPID), jadi tidak perlu enkripsi payload.
// Service worker (sw.js) mengambil isi alert dari GET /api/push/last.

export const SYMBOL = "XAUUSD";
export const STALE_AFTER_SEC = 180;  // sama dengan /api/zones: lewat 180 dtk data EA dianggap basi
const PUSH_TTL = 3600;        // detik, push dibuang kalau HP offline lebih lama dari ini (dulu 600: HP Doze >10 mnt = push hilang)
const MAX_SUBS = 2000;        // batas langganan tersimpan
const MAX_BODY = 4096;        // batas ukuran body request subscribe
const SEND_CHUNK = 25;        // jumlah push paralel per gelombang

// Alert news: kalender yang sama dengan yang tampil di web (BiQuote upcoming,
// sudah difilter importance=high di server). Cron cek tiap menit; fetch kalender
// paling cepat tiap 5 menit (cache D1) supaya tidak menghujani API.
const NEWS_CAL_URL = "https://biquote.io/api/calendar/upcoming?limit=40&countries=US,EU,GB,JP,ID&importance=high";
const NEWS_ALERT_MIN_BEFORE = 15;  // menit sebelum rilis
const NEWS_CACHE_MS = 5 * 60 * 1000;
const NEWS_FETCH_TIMEOUT_MS = 8000;
const wibTime = (ms) => new Intl.DateTimeFormat("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));

// Hanya endpoint dari layanan push resmi browser yang diterima (cegah Worker dipakai menembak URL sembarang).
const ALLOWED_HOSTS = [
  /(^|\.)fcm\.googleapis\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
  /(^|\.)push\.apple\.com$/,
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-Admin-Token",
  "Access-Control-Max-Age": "86400",
};
// Header keamanan untuk semua respons API (halaman frontend di GitHub Pages tidak
// bisa diset header-nya — ini menutup sisi Worker; lihat FIX-CHANGELOG.md).
const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...SEC_HEADERS, ...CORS, ...extra },
  });

// Perbandingan kunci tanpa early-exit (bukan timing-safe sempurna, tapi tidak bocor
// panjang kunci lewat waktu seperti `!==` pada string yang hampir sama).
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
}

// Rate limit sederhana berbasis D1 (bukan memori Worker — state Worker tidak
// persisten antar isolate). Satu baris per (IP, endpoint) per jendela waktu;
// baris lama dibersihkan saat jendela baru dibuat. Balapan dua request
// bersamaan bisa lolos 1x di atas batas — bisa diterima untuk quick win ini;
// batas keras (WAF) ada di Cloudflare dashboard, lihat NOTIFICATION-DEPLOY.md.
export async function rateLimitCheck(db, key, limit, windowSec, now = Date.now()) {
  const windowStart = Math.floor(now / 1000 / windowSec) * windowSec * 1000;
  const row = await db.prepare("SELECT count, window_start FROM rate_limits WHERE key=?").bind(key).first();
  if (!row || Number(row.window_start) !== windowStart) {
    await db.batch([
      db.prepare("INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)").bind(key, windowStart),
      db.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(now - 3600 * 1000),
    ]);
    return { allowed: true };
  }
  if (Number(row.count) >= limit) {
    return { allowed: false, retryAfter: Math.ceil((windowStart + windowSec * 1000 - now) / 1000) };
  }
  await db.prepare("UPDATE rate_limits SET count=count+1 WHERE key=?").bind(key).run();
  return { allowed: true };
}

// Riwayat alert (inbox): tiap alert yang ditulis ke push_last juga dicatat di push_history,
// dibatasi 50 terbaru supaya tabel tidak membesar tanpa batas.
function historyInsertStmt(db, title, body, tag, ts) {
  return db.prepare("INSERT INTO push_history (title, body, tag, ts) VALUES (?, ?, ?, ?)").bind(title, body, tag, ts);
}
function historyPruneStmt(db) {
  return db.prepare("DELETE FROM push_history WHERE id NOT IN (SELECT id FROM push_history ORDER BY ts DESC, id DESC LIMIT 50)");
}

/* ---------------- D1 ---------------- */

export function getDb(env) {
  return (
    env.DB || env.D1 ||
    Object.values(env).find((v) => v && typeof v.prepare === "function" && typeof v.batch === "function") ||
    null
  );
}

let schemaReady = null;
export function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db
      .batch([
        db.prepare("CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, created_at INTEGER NOT NULL)"),
        db.prepare("CREATE TABLE IF NOT EXISTS push_state (zone_key TEXT PRIMARY KEY, inside INTEGER NOT NULL, last_sent INTEGER NOT NULL DEFAULT 0)"),
        db.prepare("CREATE TABLE IF NOT EXISTS zone_trigger_state (zone_key TEXT PRIMARY KEY, symbol TEXT NOT NULL, triggered INTEGER NOT NULL DEFAULT 0, trigger_price REAL, triggered_at INTEGER, last_seen INTEGER NOT NULL)"),
        db.prepare("CREATE TABLE IF NOT EXISTS zone_announcement_state (zone_key TEXT PRIMARY KEY, symbol TEXT NOT NULL, announced_at INTEGER NOT NULL)"),
        db.prepare("CREATE TABLE IF NOT EXISTS zone_price_state (symbol TEXT PRIMARY KEY, last_price REAL NOT NULL, updated_at INTEGER NOT NULL)"),
        db.prepare("CREATE TABLE IF NOT EXISTS push_last (id INTEGER PRIMARY KEY, title TEXT, body TEXT, tag TEXT, ts INTEGER)"),
        db.prepare("CREATE TABLE IF NOT EXISTS push_history (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, body TEXT, tag TEXT, ts INTEGER)"),
        db.prepare("CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL)"),
        db.prepare("CREATE TABLE IF NOT EXISTS news_alert_state (event_key TEXT PRIMARY KEY, event_time INTEGER NOT NULL, name TEXT, alerted_at INTEGER NOT NULL)"),
        db.prepare("CREATE TABLE IF NOT EXISTS news_cache (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL)"),
      ])
      .catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

/* ---------------- VAPID ---------------- */

const enc = new TextEncoder();
function b64u(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let signKey = null;
async function getSignKey(env) {
  if (!signKey) {
    const jwk = JSON.parse(env.VAPID_PRIVATE_JWK);
    signKey = crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  }
  return signKey;
}

async function vapidAuth(env, endpoint) {
  const aud = new URL(endpoint).origin;
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const pay = b64u(enc.encode(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || "https://zonaa1.matary.id",
  })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await getSignKey(env), enc.encode(head + "." + pay));
  return `vapid t=${head}.${pay}.${b64u(sig)}, k=${env.VAPID_PUBLIC}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Kirim 1 push. Retry untuk 429 / 5xx / error jaringan (dulu: gagal sekali = alert hilang tanpa jejak).
async function sendOne(env, endpoint) {
  let status = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: await vapidAuth(env, endpoint), TTL: String(PUSH_TTL), Urgency: "high" },
      });
      status = r.status;
      if (status !== 429 && status < 500) return status;
    } catch { status = 0; }
    await sleep(250 * (attempt + 1));
  }
  return status;
}

export async function sendAll(env, db, endpoints) {
  let ok = 0, gone = 0, failed = 0;
  const codes = {};
  const suspect403 = []; // endpoint 403: baru dihapus kalau terbukti spesifik ke subscription itu (lihat bawah)
  for (let i = 0; i < endpoints.length; i += SEND_CHUNK) {
    const chunk = endpoints.slice(i, i + SEND_CHUNK);
    const res = await Promise.allSettled(chunk.map((e) => sendOne(env, e)));
    const dead = [];
    res.forEach((r, k) => {
      const code = r.status === "fulfilled" ? r.value : 0;
      codes[code] = (codes[code] || 0) + 1;
      if (code >= 200 && code < 300) ok++;
      else if (code === 404 || code === 410) { gone++; dead.push(chunk[k]); }
      else if (code === 403) { failed++; suspect403.push(chunk[k]); }
      else failed++;
    });
    if (dead.length) {
      await db.batch(dead.map((e) => db.prepare("DELETE FROM push_subs WHERE endpoint=?").bind(e)));
    }
  }
  if (suspect403.length && ok > 0) {
    // Ada yang sukses -> VAPID global sehat, jadi 403 ini spesifik ke subscription itu: hapus.
    await db.batch(suspect403.map((e) => db.prepare("DELETE FROM push_subs WHERE endpoint=?").bind(e)));
    gone += suspect403.length;
  } else if (suspect403.length && failed > 0 && suspect403.length === failed) {
    // Semua gagal 403 dan tidak ada yang sukses -> kemungkinan VAPID mismatch global:
    // jangan hapus apa pun, kalau tidak seluruh subscriber hilang karena satu key salah.
    console.log("VAPID_MISMATCH_SUSPECTED: semua push gagal 403, subscription tidak dihapus");
  }
  if (failed) console.log("PUSH GAGAL, kode HTTP:", JSON.stringify(codes));
  return { sent: ok, removed: gone, failed, codes };
}

/* ---------------- bridge ke Durable Object TickWatcher ---------------- */

export async function pingWatcher(env, path = "/ensure") {
  if (!env.TICK_WATCHER) return null;
  try {
    const stub = env.TICK_WATCHER.get(env.TICK_WATCHER.idFromName("main"));
    const r = await stub.fetch("https://tick-watcher" + path, { method: "POST" });
    return await r.json();
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

/* ---------------- endpoint /api/push/* ---------------- */

async function readJson(request) {
  const t = await request.text();
  if (t.length > MAX_BODY) throw Object.assign(new Error("payload terlalu besar"), { status: 413 });
  try { return JSON.parse(t || "{}"); } catch { throw Object.assign(new Error("JSON tidak valid"), { status: 400 }); }
}

function validEndpoint(ep) {
  try {
    const u = new URL(ep);
    return ep.length <= 1000 && u.protocol === "https:" && ALLOWED_HOSTS.some((r) => r.test(u.hostname));
  } catch { return false; }
}

const isPushAdmin = (request, env) => {
  const token = request.headers.get("X-Admin-Token") || "";
  return Boolean(env.PUSH_ADMIN_TOKEN && safeEqual(token, env.PUSH_ADMIN_TOKEN));
};

export async function handlePush(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/api/push/")) return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...SEC_HEADERS, ...CORS } });

  try {
    if (path === "/api/push/key" && request.method === "GET") {
      if (!env.VAPID_PUBLIC) return json({ error: "VAPID belum diset" }, 503);
      return json({ key: env.VAPID_PUBLIC });
    }

    const db = getDb(env);
    if (!db) return json({ error: "D1 tidak ditemukan" }, 500);
    await ensureSchema(db);

    if (path === "/api/push/last" && request.method === "GET") {
      const row = await db.prepare("SELECT title, body, tag, ts FROM push_last WHERE id=1").first();
      return json(row || {});
    }

    // Riwayat alert, publik (seperti /api/push/last): 20 terbaru, untuk inbox di halaman.
    if (path === "/api/push/history" && request.method === "GET") {
      const { results } = await db.prepare("SELECT title, body, tag, ts FROM push_history ORDER BY ts DESC, id DESC LIMIT 20").all();
      return json({ alerts: results || [] });
    }

    if (path === "/api/push/subscribe" && request.method === "POST") {
      // Tanpa ini, siapa pun bisa memenuhi kuota 2000 langganan dengan endpoint
      // sampah dan user asli ditolak 429. 5/menit/IP lebih dari cukup (daftar
      // ulang hanya terjadi saat install ulang PWA / ganti kunci VAPID).
      const rl = await rateLimitCheck(db, `rl:${clientIp(request)}:subscribe`, 5, 60);
      if (!rl.allowed) return json({ error: "terlalu banyak permintaan, coba lagi" }, 429, { "Retry-After": String(rl.retryAfter) });
      const body = await readJson(request);
      const ep = body && body.subscription && body.subscription.endpoint;
      if (!validEndpoint(ep)) return json({ error: "endpoint tidak valid" }, 400);
      const exists = await db.prepare("SELECT 1 AS x FROM push_subs WHERE endpoint=?").bind(ep).first();
      if (!exists) {
        const c = await db.prepare("SELECT COUNT(*) AS c FROM push_subs").first();
        if (c && c.c >= MAX_SUBS) return json({ error: "kuota langganan penuh" }, 429);
      }
      await db.prepare(
        "INSERT INTO push_subs (endpoint, created_at) VALUES (?, ?) ON CONFLICT(endpoint) DO UPDATE SET created_at=excluded.created_at"
      ).bind(ep, Date.now()).run();
      return json({ ok: true });
    }

    if (path === "/api/push/unsubscribe" && request.method === "POST") {
      const body = await readJson(request);
      const ep = body && body.endpoint;
      if (typeof ep === "string") await db.prepare("DELETE FROM push_subs WHERE endpoint=?").bind(ep).run();
      return json({ ok: true });
    }

    // Tes manual: curl -X POST -H "X-Admin-Token: <PUSH_ADMIN_TOKEN>" https://<worker>/api/push/test
    if (path === "/api/push/test" && request.method === "POST") {
      if (!isPushAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const testTs = Date.now();
      await db.batch([
        db.prepare(
          "INSERT INTO push_last (id, title, body, tag, ts) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body, tag=excluded.tag, ts=excluded.ts"
        ).bind("TES ZONA A1", "Notifikasi HP berfungsi. Alert zona akan masuk seperti ini.", "a1-test", testTs),
        historyInsertStmt(db, "TES ZONA A1", "Notifikasi HP berfungsi. Alert zona akan masuk seperti ini.", "a1-test", testTs),
        historyPruneStmt(db),
      ]);
      const { results } = await db.prepare("SELECT endpoint FROM push_subs").all();
      return json({ subscribers: results.length, ...(await sendAll(env, db, results.map((r) => r.endpoint))) });
    }

    // Diagnosa: curl -H "X-Admin-Token: <PUSH_ADMIN_TOKEN>" https://<worker>/api/push/status
    // Isinya: status WebSocket Exness, umur tick terakhir, harga, jumlah zona, subscriber, push terakhir.
    if (path === "/api/push/status" && request.method === "GET") {
      if (!isPushAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const subs = await db.prepare("SELECT COUNT(*) AS c FROM push_subs").first();
      const last = await db.prepare("SELECT title, body, ts FROM push_last WHERE id=1").first();
      const lastNews = await db.prepare("SELECT name, event_time, alerted_at FROM news_alert_state ORDER BY alerted_at DESC LIMIT 1").first();
      const watcher = await pingWatcher(env, "/status");
      return json({ now: Date.now(), subscribers: subs ? subs.c : 0, last_push: last || null, last_news_alert: lastNews || null, watcher });
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, (e && e.status) || 500);
  }
}

/* ---------------- endpoint /api/zones/trigger (EA -> Worker, langsung) ---------------- */

// EA memanggil POST /api/zones/trigger tiap tick saat harga masuk BR1/BR2.
// Dulu route ini tidak ada di Worker (router hanya cocok /api/zones persis) sehingga
// trigger langsung EA selalu 404. Alasan "tidak fire" dikembalikan sebagai HTTP 200
// (bukan 4xx): EA menganggap non-200 sebagai gagal dan akan retry tiap 5 detik.
export async function handleZoneTrigger(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...SEC_HEADERS, ...CORS } });
  if (request.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);

  // Rate limit SEBELUM cek kunci: banjir request tidak boleh membebani D1/auth.
  // 60/menit/IP longgar untuk EA (trigger hanya saat harga masuk zona).
  const dbRl = getDb(env);
  if (dbRl) {
    await ensureSchema(dbRl);
    const rl = await rateLimitCheck(dbRl, `rl:${clientIp(request)}:trigger`, 60, 60);
    if (!rl.allowed) return json({ ok: false, error: "rate limited" }, 429, { "Retry-After": String(rl.retryAfter) });
  }

  const expected = env.ZONES_API_KEY || env.API_KEY;
  if (!expected) return json({ ok: false, error: "API key not configured" }, 500);
  if (!safeEqual(request.headers.get("X-API-Key") || "", expected)) return json({ ok: false, error: "unauthorized" }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "invalid json" }, 400); }

  const symbol = baseSymbol(String(body.symbol || SYMBOL).toUpperCase());
  const tf = String(body.tf || "").toUpperCase();
  const bias = String(body.bias || "").toUpperCase();
  const block = String(body.block || "").toUpperCase();
  const top = num(body.top), bottom = num(body.bottom), price = num(body.price);
  const VALID_TF = ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"];
  if (!VALID_TF.includes(tf) || (bias !== "BUY" && bias !== "SELL") || (block !== "BR1" && block !== "BR2") ||
      top === null || bottom === null || price === null) {
    return json({ ok: false, error: "invalid trigger payload" }, 400);
  }

  const db = getDb(env);
  if (!db) return json({ ok: false, error: "D1 tidak ditemukan" }, 500);
  await ensureSchema(db);
  const now = Date.now();

  // Zona cocok kalau tf+bias+block sama, status FRESH (parseZones sudah menyaring ini),
  // dan harga trigger berada di dalam batas zona snapshot.
  const { zones } = await loadActiveZones(db, symbol);
  const z = zones.find((zz) => zz.tf === tf && zz.bias === bias && zz.block === block && price >= zz.lo && price <= zz.hi);
  if (!z) return json({ ok: true, fired: false, reason: "zone-not-active" });

  // Pakai key zona hasil parseZones (z.key), BUKAN key yang dibangun ulang dari tf:
  // sejak EA mengirim chart_id di snapshot, key TickWatcher adalah
  // `${chart_id}|${tf}|${block}|${bias}` — membangun key `${tf}|${tf}|...` di sini
  // akan menulis baris trigger yang berbeda dan membuat cek already-triggered
  // meleset (double-fire). z.key identik dengan triggerKey() di zones-endpoint.js.
  const state = await db.prepare("SELECT triggered FROM zone_trigger_state WHERE zone_key=?").bind(z.key).first();
  if (state && state.triggered) return json({ ok: true, fired: false, reason: "already-triggered" });

  const result = await commitAndPush(env, db, [triggerStmt(db, z, price, now)], [z], price, now);
  return json({ ok: true, fired: true, ...result });
}

/* ---------------- logika zona (dipakai TickWatcher & fallback cron) ---------------- */

// Normalisasi simbol: akun Standard/Cent mengirim XAUUSDm/XAUUSDc, tapi snapshot zona,
// state trigger, dan lookup zona semuanya memakai simbol dasar XAUUSD. Simbol persis akun
// (mis. XAUUSDm) TETAP dipakai untuk subscribe WebSocket Exness — hanya lookup zona yang dinormalisasi.
export function baseSymbol(s) {
  const up = String(s || "").toUpperCase();
  const m = up.match(/^(XAUUSD)[MC]$/);
  return m ? m[1] : up;
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// HARUS identik dengan triggerKey() di zones-endpoint.js (status TRIGGERED di dashboard dicocokkan lewat key ini).
// Harus sama dengan triggerKey() di zones-endpoint.js. Jangan masukkan lo/hi:
// perubahan kecil batas harga tidak boleh membuka ulang notifikasi zona yang sama.
function zoneKey(z, block, lo, hi) {
  return `${z.chart_id || z.tf}|${z.tf}|${block}|${String(z.bias || '').toUpperCase()}`;
}

export function parseZones(data, now = Date.now()) {
  const out = [];
  if (!data || data.stale) return out;
  for (const z of Array.isArray(data.zones) ? data.zones : []) {
    // Zona per-TF yang EA-nya sudah berhenti kirim > 180 dtk dibuang (sama dengan GET /api/zones).
    // Dulu zona basi ikut dicek selama TF lain masih kirim heartbeat -> alert palsu.
    const upd = Number(z && z.updated_at);
    if (!Number.isFinite(upd) || now - upd > STALE_AFTER_SEC * 1000) continue;
    const bias = String((z && z.bias) || "").toUpperCase();
    if (bias !== "BUY" && bias !== "SELL") continue;
    const tf = String(z.tf || "");
    for (const [block, box, status] of [["BR1", z.br1, z.status_br1], ["BR2", z.br2, z.status_br2]]) {
      const t = num(box && box.top), b = num(box && box.bottom);
      if (t === null || b === null || String(status || "").toUpperCase() !== "FRESH") continue;
      const lo = Math.min(t, b), hi = Math.max(t, b);
      out.push({ key: zoneKey(z, block, lo, hi), announcementKey: `${z.chart_id || z.tf}|${tf}|${block}|${bias}`, tf, bias, block, lo, hi, chart_id: z.chart_id || null });
    }
  }
  return out;
}

export async function loadActiveZones(db, symbol = SYMBOL) {
  let row = null;
  try {
    row = await db.prepare("SELECT payload, updated_at FROM zone_snapshots WHERE symbol = ?1").bind(baseSymbol(symbol)).first();
  } catch { row = null; }
  if (!row) return { skipped: "zones-unavailable", zones: [] };
  const now = Date.now();
  if ((now - row.updated_at) / 1000 > STALE_AFTER_SEC) return { skipped: "zones-stale", zones: [] };
  let list = [];
  try { list = JSON.parse(row.payload); } catch { list = []; }
  return { zones: parseZones({ stale: false, zones: Array.isArray(list) ? list : [] }, now) };
}

// Aturan trigger:
//  - lintasan: BUY = harga turun dari atas zona sampai menyentuh/menembus; SELL = naik dari bawah.
//    (juga menangkap lompatan yang melewati seluruh lebar zona)
//  - first = zona baru pertama kali dilihat. Kalau harga SUDAH di dalam zona saat itu, langsung trigger.
//    (Dulu kasus ini tidak pernah trigger: prevPrice sudah di dalam zona, jadi "lintasan" tidak terjadi
//     -> persis kasus "harga sudah sampai BR2 tapi notif nggak masuk".)
export function shouldFire(z, price, prev, first) {
  if (z.bias === "BUY") {
    const crossed = prev !== null && prev > z.hi && price <= z.hi;
    const inside = first && price <= z.hi && price >= z.lo;
    return crossed || inside;
  }
  const crossed = prev !== null && prev < z.lo && price >= z.lo;
  const inside = first && price >= z.lo && price <= z.hi;
  return crossed || inside;
}

export function triggerStmt(db, z, price, now) {
  return db.prepare(
    "INSERT INTO zone_trigger_state (zone_key, symbol, triggered, trigger_price, triggered_at, last_seen) VALUES (?, ?, 1, ?, ?, ?) " +
    "ON CONFLICT(zone_key) DO UPDATE SET triggered=1, " +
    "trigger_price=CASE WHEN zone_trigger_state.triggered=0 THEN excluded.trigger_price ELSE zone_trigger_state.trigger_price END, " +
    "triggered_at=CASE WHEN zone_trigger_state.triggered=0 THEN excluded.triggered_at ELSE zone_trigger_state.triggered_at END, " +
    "last_seen=excluded.last_seen"
  ).bind(z.key, SYMBOL, price, now, now);
}

// Catat zona "terlihat" tanpa mengubah status triggered.
export function seenStmt(db, z, now) {
  return db.prepare(
    "INSERT INTO zone_trigger_state (zone_key, symbol, triggered, trigger_price, triggered_at, last_seen) VALUES (?, ?, 0, NULL, NULL, ?) " +
    "ON CONFLICT(zone_key) DO UPDATE SET last_seen=excluded.last_seen"
  ).bind(z.key, SYMBOL, now);
}

// Hapus penanda trigger satu zona (dipakai saat reset keluar zona & saat push gagal total).
export function deleteTriggerStmt(db, key) {
  return db.prepare("DELETE FROM zone_trigger_state WHERE zone_key=?").bind(key);
}

const fmt = (n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Tulis state + isi alert ke D1 dulu (supaya SW bisa baca /api/push/last), baru kirim push.
export async function commitAndPush(env, db, stmts, fired, price, now = Date.now()) {
  const lines = fired.slice(0, 3).map((z) => `${z.bias} ${z.tf} · ${z.block}: harga ${fmt(price)} menembus area ${fmt(z.lo)} – ${fmt(z.hi)}`);
  if (fired.length > 3) lines.push(`+${fired.length - 3} zona lain`);
  const title = fired.length === 1 ? `ZONA ${fired[0].bias} ${fired[0].tf} · ${fired[0].block} TRIGGERED` : `${fired.length} ZONA TRIGGERED`;
  // Tag unik per alert (dulu "a1-zone" untuk semua): supaya tiap trigger tampil sendiri di tray,
  // bukan menimpa notifikasi sebelumnya. SW memakai payload.tag dari /api/push/last.
  const tag = "a1-zone-" + now;
  stmts.push(
    db.prepare("INSERT INTO push_last (id, title, body, tag, ts) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body, tag=excluded.tag, ts=excluded.ts")
      .bind(title, lines.join("\n"), tag, now),
    historyInsertStmt(db, title, lines.join("\n"), tag, now),
    historyPruneStmt(db)
  );
  await db.batch(stmts);
  const { results: subs } = await db.prepare("SELECT endpoint FROM push_subs").all();
  if (!subs.length) return { fired: fired.length, price, subscribers: 0 };
  return { fired: fired.length, price, ...(await sendAll(env, db, subs.map((s) => s.endpoint))) };
}


// Alert pembentukan zona baru, terpisah dari alert harga menyentuh zona.
// Dipanggil dari TickWatcher.reloadZones() saat pertama kali melihat zona FRESH;
// sekali per zona (dicatat di zone_announcement_state), retry 60 dtk kalau gagal kirim.
export async function commitNewZoneAndPush(env, db, zones, now = Date.now()) {
  if (!zones.length) return { announced: 0, subscribers: 0 };
  const lines = zones.slice(0, 4).map(z => `${z.bias} ${z.tf} · ${z.block}`);
  if (zones.length > 4) lines.push(`+${zones.length - 4} zona lain`);
  const title = zones.length === 1
    ? `NEW ZONE ${zones[0].bias} · ${zones[0].tf} ${zones[0].block}`
    : `${zones.length} NEW ZONES · XAUUSD`;
  const body = `Zona baru terbentuk pada XAUUSD.\n${lines.join("\n")}\nPantau area dan tunggu konfirmasi sebelum entry.`;
  const newZoneTag = `a1-new-zone-${now}`;
  await db.batch([
    db.prepare(
      "INSERT INTO push_last (id, title, body, tag, ts) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body, tag=excluded.tag, ts=excluded.ts"
    ).bind(title, body, newZoneTag, now),
    historyInsertStmt(db, title, body, newZoneTag, now),
    historyPruneStmt(db),
  ]);
  const { results: subs } = await db.prepare("SELECT endpoint FROM push_subs").all();
  if (!subs.length) return { announced: zones.length, subscribers: 0 };
  return { announced: zones.length, ...(await sendAll(env, db, subs.map(s => s.endpoint))) };
}

/* ---------------- alert news: 15 menit sebelum rilis high-impact USD ---------------- */

// Normalisasi event kalender BiQuote -> { key, timeMs, name }. Hanya high-impact
// USD yang lolos (EUR/GB/JP/ID dari API yang sama sengaja tidak diumumkan —
// penggerak XAUUSD adalah USD; kalau mau diperluas, ubah filter currency di sini).
// Bentuk field dipertahankan longgar karena API bisa memakai nama field berbeda
// (time/date/datetime, name/title, currency/countryCode).
export function parseNewsEvents(data) {
  const list = Array.isArray(data)
    ? data
    : (data && (Array.isArray(data.data) ? data.data : (Array.isArray(data.events) ? data.events : [])));
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const rawTime = e.time ?? e.date ?? e.datetime ?? e.time_utc ?? e.release_at ?? e.timestamp;
    let timeMs = null;
    if (typeof rawTime === "number") timeMs = rawTime < 1e12 ? rawTime * 1000 : rawTime;
    else if (typeof rawTime === "string") { const t = Date.parse(rawTime); if (Number.isFinite(t)) timeMs = t; }
    if (!timeMs) continue;
    const name = String(e.name ?? e.title ?? e.event ?? "").trim() || "Economic event";
    const currency = String(e.currency ?? e.countryCode ?? e.country ?? "").toUpperCase();
    const importance = String(e.importance ?? e.impact ?? "").toLowerCase();
    if (!importance.includes("high")) continue;
    if (currency !== "USD" && currency !== "US") continue;
    out.push({ key: `${timeMs}|${name.toLowerCase()}`, timeMs, name, currency: "USD" });
  }
  out.sort((a, b) => a.timeMs - b.timeMs);
  return out;
}

// Kalender upcoming, cache D1 max 5 menit. Kalau fetch gagal dan ada cache lama,
// pakai cache lama (jadwal rilis tidak berubah tiap menit); kalau tidak ada cache,
// kembalikan [] — cron menit berikutnya mencoba lagi.
async function getUpcomingNews(db, now, fetchFn) {
  const row = await db.prepare("SELECT payload, fetched_at FROM news_cache WHERE id=1").first().catch(() => null);
  if (row && now - Number(row.fetched_at) < NEWS_CACHE_MS) {
    try { return parseNewsEvents(JSON.parse(row.payload)); } catch { /* jatuh ke fetch */ }
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), NEWS_FETCH_TIMEOUT_MS);
    let res;
    try { res = await fetchFn(NEWS_CAL_URL, { signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
    if (!res || !res.ok) throw new Error("calendar HTTP " + (res && res.status));
    const data = await res.json();
    await db.prepare(
      "INSERT INTO news_cache (id, payload, fetched_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at"
    ).bind(JSON.stringify(data), now).run();
    return parseNewsEvents(data);
  } catch (e) {
    console.log("NEWS CALENDAR FETCH ERROR:", String((e && e.message) || e));
    if (row) { try { return parseNewsEvents(JSON.parse(row.payload)); } catch { /* abaikan */ } }
    return [];
  }
}

async function commitNewsAlertAndPush(env, db, events, now) {
  const lines = events.slice(0, 4).map((e) => `${wibTime(e.timeMs)} WIB — ${e.name}`);
  if (events.length > 4) lines.push(`+${events.length - 4} rilis lain`);
  const title = events.length === 1
    ? `NEWS USD — ${events[0].name}`
    : `${events.length} NEWS USD · 15 MENIT LAGI`;
  const body = events.length === 1
    ? `Rilis ${events[0].name} (USD) 15 menit lagi, pukul ${wibTime(events[0].timeMs)} WIB.\nPantau XAUUSD — volatilitas biasa naik saat rilis.`
    : `Rilis high-impact USD 15 menit lagi:\n${lines.join("\n")}\nPantau XAUUSD — volatilitas biasa naik saat rilis.`;
  const tag = `a1-news-${now}`;
  await db.batch([
    db.prepare(
      "INSERT INTO push_last (id, title, body, tag, ts) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body, tag=excluded.tag, ts=excluded.ts"
    ).bind(title, body, tag, now),
    historyInsertStmt(db, title, body, tag, now),
    historyPruneStmt(db),
  ]);
  const { results: subs } = await db.prepare("SELECT endpoint FROM push_subs").all();
  if (!subs.length) return { alerted: events.length, subscribers: 0 };
  return { alerted: events.length, ...(await sendAll(env, db, subs.map((s) => s.endpoint))) };
}

// Dipanggil cron tiap menit. Alert saat rilis masuk jendela (0, 15 menit] —
// cron yang kelewat 1 menit tetap mengirim (terlambat sedikit lebih baik daripada
// tidak sama sekali). Sekali per event (news_alert_state); kalau kirim gagal
// total, TIDAK ditandai alerted supaya menit berikutnya mencoba lagi.
export async function checkNewsAlerts(env, db, now = Date.now(), fetchFn = fetch) {
  const events = await getUpcomingNews(db, now, fetchFn);
  const inWindow = events.filter((e) => e.timeMs - now > 0 && e.timeMs - now <= NEWS_ALERT_MIN_BEFORE * 60 * 1000);
  if (!inWindow.length) return { checked: events.length, alerted: 0 };
  const { results } = await db.prepare("SELECT event_key FROM news_alert_state").all();
  const alerted = new Set((results || []).map((r) => r.event_key));
  const toAlert = inWindow.filter((e) => !alerted.has(e.key));
  if (!toAlert.length) return { checked: events.length, alerted: 0 };
  const res = await commitNewsAlertAndPush(env, db, toAlert, now);
  const sent = res.sent || 0;
  if (res.subscribers === 0 || sent > 0) {
    await db.batch([
      ...toAlert.map((e) => db.prepare(
        "INSERT OR REPLACE INTO news_alert_state (event_key, event_time, name, alerted_at) VALUES (?, ?, ?, ?)"
      ).bind(e.key, e.timeMs, e.name, now)),
      db.prepare("DELETE FROM news_alert_state WHERE event_time < ?").bind(now - 3600 * 1000),
    ]);
  }
  return { checked: events.length, alerted: toAlert.length, ...res };
}

/* ---------------- cron: Exness WebSocket watchdog + cek news ---------------- */

export async function runPushAlerts(env) {
  // VPS-free mode: Exness WebSocket is the only market-price source.
  // Cron adalah watchdog/bootstrap + cek kalender news. Cron TIDAK mengambil
  // harga dari BiQuote atau API harga lain (BiQuote di sini hanya kalender event).
  const db = getDb(env);
  if (!db) return { skipped: "no-db" };
  await ensureSchema(db);
  const watcher = await pingWatcher(env, "/ensure");
  // News tidak boleh mematikan watchdog: gagal fetch kalender = lewati menit ini.
  let news = null;
  try { news = await checkNewsAlerts(env, db); }
  catch (e) { console.log("NEWS ALERT ERROR:", String((e && e.message) || e)); news = { error: String((e && e.message) || e) }; }
  return {
    via: "exness-websocket",
    configured: Boolean(watcher && watcher.configured),
    connected: Boolean(watcher && watcher.connected),
    tickAgeSec: watcher ? watcher.tickAgeSec : null,
    last_error: watcher ? watcher.last_error : "watcher-unavailable",
    news,
  };
}

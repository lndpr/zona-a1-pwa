// push-alerts.js — Web Push alert zona ZONA A1 (Cloudflare Worker, module syntax)
//
// Dipakai dari Worker zona-a1-signal-api (src/index.js):
//   - handlePush(request, env)  -> Response | null   (endpoint /api/push/*)
//   - runPushAlerts(env)                              (dipanggil dari cron tiap menit)
//
// ALUR BARU:
//   * Deteksi utama = Durable Object TickWatcher (tick-watcher.js) yang menahan WebSocket ticks
//     Exness 24/7 -> alert terkirim dalam hitungan detik, bukan nunggu cron.
//   * Cron tiap menit cuma jadi watchdog (nyalain ulang WebSocket) + FALLBACK polling biquote
//     kalau WebSocket Exness mati / belum dikonfigurasi.
// Zona dibaca dari tabel D1 zone_snapshots (diisi EA lewat /api/zones).
//
// Push dikirim TANPA payload (hanya header VAPID), jadi tidak perlu enkripsi payload.
// Service worker (sw.js) mengambil isi alert dari GET /api/push/last.

export const SYMBOL = "XAUUSD";
export const STALE_AFTER_SEC = 180;  // sama dengan /api/zones: lewat 180 dtk data EA dianggap basi
const PUSH_TTL = 600;         // detik, push dibuang kalau HP offline lebih lama dari ini
const MAX_SUBS = 2000;        // batas langganan tersimpan
const MAX_BODY = 4096;        // batas ukuran body request subscribe
const SEND_CHUNK = 25;        // jumlah push paralel per gelombang

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
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });

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
        db.prepare("CREATE TABLE IF NOT EXISTS zone_announcement_state (zone_key TEXT PRIMARY KEY, symbol TEXT NOT NULL, announced_at INTEGER NOT NULL, last_seen INTEGER NOT NULL DEFAULT 0)"),
        db.prepare("CREATE TABLE IF NOT EXISTS zone_price_state (symbol TEXT PRIMARY KEY, last_price REAL NOT NULL, updated_at INTEGER NOT NULL)"),
        db.prepare("CREATE TABLE IF NOT EXISTS push_last (id INTEGER PRIMARY KEY, title TEXT, body TEXT, tag TEXT, ts INTEGER)"),
      ])
      .then(async () => {
        // Migrasi tabel lama agar zona yang sempat hilang bisa diberi grace period.
        try {
          await db.prepare("ALTER TABLE zone_announcement_state ADD COLUMN last_seen INTEGER NOT NULL DEFAULT 0").run();
        } catch (e) {
          // D1/SQLite mengembalikan error jika kolom sudah ada; error lain tetap dilempar.
          if (!String((e && e.message) || e).toLowerCase().includes("duplicate column")) throw e;
        }
      })
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
  for (let i = 0; i < endpoints.length; i += SEND_CHUNK) {
    const chunk = endpoints.slice(i, i + SEND_CHUNK);
    const res = await Promise.allSettled(chunk.map((e) => sendOne(env, e)));
    const dead = [];
    res.forEach((r, k) => {
      const code = r.status === "fulfilled" ? r.value : 0;
      codes[code] = (codes[code] || 0) + 1;
      if (code >= 200 && code < 300) ok++;
      else if (code === 404 || code === 410) { gone++; dead.push(chunk[k]); }
      else failed++;
    });
    if (dead.length) {
      await db.batch(dead.map((e) => db.prepare("DELETE FROM push_subs WHERE endpoint=?").bind(e)));
    }
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
  return Boolean(env.PUSH_ADMIN_TOKEN && token === env.PUSH_ADMIN_TOKEN);
};

export async function handlePush(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/api/push/")) return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

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

    if (path === "/api/push/subscribe" && request.method === "POST") {
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
      await db.prepare(
        "INSERT INTO push_last (id, title, body, tag, ts) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body, tag=excluded.tag, ts=excluded.ts"
      ).bind("TES ZONA A1", "Notifikasi HP berfungsi. Alert zona akan masuk seperti ini.", "a1-test", Date.now()).run();
      const { results } = await db.prepare("SELECT endpoint FROM push_subs").all();
      return json({ subscribers: results.length, ...(await sendAll(env, db, results.map((r) => r.endpoint))) });
    }

    // Diagnosa: curl -H "X-Admin-Token: <PUSH_ADMIN_TOKEN>" https://<worker>/api/push/status
    // Isinya: status WebSocket Exness, umur tick terakhir, harga, jumlah zona, subscriber, push terakhir.
    if (path === "/api/push/status" && request.method === "GET") {
      if (!isPushAdmin(request, env)) return json({ error: "unauthorized" }, 401);
      const subs = await db.prepare("SELECT COUNT(*) AS c FROM push_subs").first();
      const last = await db.prepare("SELECT title, body, ts FROM push_last WHERE id=1").first();
      const watcher = await pingWatcher(env, "/status");
      return json({ now: Date.now(), subscribers: subs ? subs.c : 0, last_push: last || null, watcher });
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: String((e && e.message) || e) }, (e && e.status) || 500);
  }
}

/* ---------------- logika zona (dipakai TickWatcher & fallback cron) ---------------- */

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
      // Kunci pengumuman tidak memakai chart_id: ID chart bisa berubah saat EA restart/re-attach.
      // Siklus zona baru dibedakan dari zona lama lewat masa tidak terlihat (grace period) di TickWatcher.
      out.push({ key: zoneKey(z, block, lo, hi), announcementKey: `${tf}|${block}|${bias}`, tf, bias, block, lo, hi, chart_id: z.chart_id || null });
    }
  }
  return out;
}

export async function loadActiveZones(db) {
  let row = null;
  try {
    row = await db.prepare("SELECT payload, updated_at FROM zone_snapshots WHERE symbol = ?1").bind(SYMBOL).first();
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

const fmt = (n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Tulis state + isi alert ke D1 dulu (supaya SW bisa baca /api/push/last), baru kirim push.
export async function commitAndPush(env, db, stmts, fired, price, now = Date.now()) {
  const lines = fired.slice(0, 3).map((z) => `${z.bias} ${z.tf} · ${z.block}: harga ${fmt(price)} menembus area ${fmt(z.lo)} – ${fmt(z.hi)}`);
  if (fired.length > 3) lines.push(`+${fired.length - 3} zona lain`);
  const title = fired.length === 1 ? `ZONA ${fired[0].bias} ${fired[0].tf} · ${fired[0].block} TRIGGERED` : `${fired.length} ZONA TRIGGERED`;
  stmts.push(
    db.prepare("INSERT INTO push_last (id, title, body, tag, ts) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body, tag=excluded.tag, ts=excluded.ts")
      .bind(title, lines.join("\n"), "a1-zone", now)
  );
  await db.batch(stmts);
  const { results: subs } = await db.prepare("SELECT endpoint FROM push_subs").all();
  if (!subs.length) return { fired: fired.length, price, subscribers: 0 };
  return { fired: fired.length, price, ...(await sendAll(env, db, subs.map((s) => s.endpoint))) };
}


// Alert pembentukan zona baru, terpisah dari alert harga menyentuh zona.
export async function commitNewZoneAndPush(env, db, zones, now = Date.now()) {
  if (!zones.length) return { announced: 0, subscribers: 0 };
  const lines = zones.slice(0, 4).map(z => `${z.bias} ${z.tf} · ${z.block}`);
  if (zones.length > 4) lines.push(`+${zones.length - 4} zona lain`);
  const title = zones.length === 1
    ? `NEW ZONE ${zones[0].bias} · ${zones[0].tf} ${zones[0].block}`
    : `${zones.length} NEW ZONES · XAUUSD`;
  const body = `Zona baru terbentuk pada XAUUSD.\n${lines.join("\n")}\nPantau area dan tunggu konfirmasi sebelum entry.`;
  await db.prepare(
    "INSERT INTO push_last (id, title, body, tag, ts) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body, tag=excluded.tag, ts=excluded.ts"
  ).bind(title, body, `a1-new-zone-${now}`, now).run();
  const { results: subs } = await db.prepare("SELECT endpoint FROM push_subs").all();
  if (!subs.length) return { announced: zones.length, subscribers: 0 };
  return { announced: zones.length, ...(await sendAll(env, db, subs.map(s => s.endpoint))) };
}

/* ---------------- cron: Exness WebSocket watchdog only ---------------- */

export async function runPushAlerts(env) {
  // VPS-free mode: Exness WebSocket is the only market-price source.
  // Cron is only a watchdog/bootstrap; it NEVER polls BiQuote or another quote API.
  const db = getDb(env);
  if (!db) return { skipped: "no-db" };
  await ensureSchema(db);
  const watcher = await pingWatcher(env, "/ensure");
  return {
    via: "exness-websocket",
    configured: Boolean(watcher && watcher.configured),
    connected: Boolean(watcher && watcher.connected),
    tickAgeSec: watcher ? watcher.tickAgeSec : null,
    last_error: watcher ? watcher.last_error : "watcher-unavailable",
  };
}

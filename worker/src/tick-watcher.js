// tick-watcher.js — Durable Object "TickWatcher"
//
// Menahan 1 koneksi WebSocket ticks Exness (XAUUSD) dan mengecek harga vs zona BR1/BR2 di SETIAP tick
// (Exness mengirim max 1 update / 500 ms), bukan sekali semenit seperti cron. Begitu zona tersentuh:
// tulis state ke D1 -> kirim Web Push. Pakai tabel & key yang sama dengan push-alerts.js, jadi dashboard
// (status TRIGGERED) dan popup di halaman tetap jalan tanpa perubahan.
//
// Secret / var yang dibutuhkan (lihat wrangler.toml):
//   EXN_API_KEY, EXN_PRIVATE_KEY, EXN_ACCOUNT_ID, dan salah satu dari EXN_ACCESS_POINT / EXN_GATEWAY_URL
//   EXN_SYMBOL (var, default XAUUSD — sesuaikan suffix akun: XAUUSDm untuk Standard)

import {
  getDb, ensureSchema, loadActiveZones, shouldFire, triggerStmt, seenStmt, commitAndPush,
  commitNewZoneAndPush,
  deleteTriggerStmt, baseSymbol,
  SYMBOL, STALE_AFTER_SEC,
} from "./push-alerts.js";

const enc = new TextEncoder();
const EMPTY_BODY_HASH = "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"; // SHA-256 body kosong, base64url
const ZONE_REFRESH_MS = 5000;   // zona dibaca ulang dari D1 paling cepat tiap 5 dtk (+ langsung saat EA kirim snapshot)
const RESET_MARGIN = 0.5;       // USD: harga sisi zona harus keluar sejauh ini dari batas zona agar trigger boleh bunyi lagi
const FLUSH_MS = 30000;         // refresh last_seen zona di D1
const STALE_MS = 90000;         // tidak ada pesan 90 dtk -> koneksi dianggap mati, sambung ulang
const WATCHDOG_MS = 20000;      // alarm pengecek koneksi
const MAX_BACKOFF_MS = 30000;

/* ---------------- util ---------------- */

function b64u(bytes) {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function hexToBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const jsonRes = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const normHost = (h) => String(h || "").trim().replace(/^(https?|wss?):\/\//, "").replace(/\/+$/, "");

const configured = (env) =>
  Boolean(env.EXN_API_KEY && env.EXN_PRIVATE_KEY && env.EXN_ACCOUNT_ID && (env.EXN_ACCESS_POINT || env.EXN_GATEWAY_URL));

// Pasar emas tutup Jumat ~21:00/22:00 UTC, buka Minggu ~21:00/22:00 UTC (tergantung DST). Margin 30 mnt.
function weekendClosed(ms) {
  const d = new Date(ms);
  const day = d.getUTCDay();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (day === 6) return true;
  if (day === 5 && mins >= 22 * 60 + 30) return true;
  if (day === 0 && mins < 20 * 60 + 30) return true;
  return false;
}

/* ---------------- Exness request signing (Ed25519) ---------------- */

// Header PKCS#8 untuk Ed25519; tinggal ditempel seed 32 byte.
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

let keyPromise = null;
async function importKey(env) {
  const raw = String(env.EXN_PRIVATE_KEY || "").trim();
  let der;
  if (raw.includes("BEGIN")) {
    // PEM (private.pem buatan sendiri)
    const b64 = raw.replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } else if (/^[0-9a-fA-F]{128}$/.test(raw) || /^[0-9a-fA-F]{64}$/.test(raw)) {
    // 128 hex dari Exness (32 byte seed + 32 byte public key) — yang dipakai hanya seed
    const seed = hexToBytes(raw.slice(0, 64));
    der = new Uint8Array(PKCS8_PREFIX.length + 32);
    der.set(PKCS8_PREFIX);
    der.set(seed, PKCS8_PREFIX.length);
  } else {
    throw new Error("EXN_PRIVATE_KEY format tidak dikenal (pakai 128 hex dari Exness atau PEM PKCS#8)");
  }
  try {
    return await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
  } catch {
    // nama algoritma lama di runtime Workers
    return crypto.subtle.importKey("pkcs8", der, { name: "NODE-ED25519", namedCurve: "NODE-ED25519" }, false, ["sign"]);
  }
}
function getKey(env) {
  if (!keyPromise) keyPromise = importKey(env).catch((e) => { keyPromise = null; throw e; });
  return keyPromise;
}

// Sign request GET (handshake WebSocket juga GET). path = path + query persis seperti yang dikirim.
async function signHeaders(env, method, path) {
  const ts = Date.now();
  const bytes = enc.encode(JSON.stringify({
    api_key: env.EXN_API_KEY,
    idempotency_key: "",
    timestamp: ts,
    sign_version: 1,
    method,
    path,
    body_hash: EMPTY_BODY_HASH,
  }));
  const key = await getKey(env);
  const sig = await crypto.subtle.sign(key.algorithm.name, key, bytes);
  return {
    "EXN-API-KEY": env.EXN_API_KEY,
    "EXN-IDEMPOTENCY-KEY": "",
    "EXN-TIMESTAMP": String(ts),
    "EXN-SIGN-VERSION": "1",
    "EXN-DATA": b64u(bytes),
    "EXN-SIGN": b64u(new Uint8Array(sig)),
  };
}

/* ---------------- parser tick ---------------- */

// Skema pesan tick tidak tercantum di halaman dokumentasi yang saya baca, jadi parser dibuat toleran:
// cari objek mana pun yang punya bid & ask (dan instrumen yang cocok kalau ada namanya).
export function extractTick(node, sym, depth = 0) {
  if (!node || typeof node !== "object" || depth > 5) return null;
  if (Array.isArray(node)) {
    let best = null;
    for (const x of node) { const t = extractTick(x, sym, depth + 1); if (t) best = t; }
    return best;
  }
  const bid = num(node.bid), ask = num(node.ask);
  const name = node.instrument ?? node.symbol;
  if (bid !== null && ask !== null && bid > 0 && ask > 0 && (!name || String(name).toUpperCase() === sym.toUpperCase())) {
    return { bid, ask, price: (bid + ask) / 2 };
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === "object") { const t = extractTick(v, sym, depth + 1); if (t) return t; }
  }
  return null;
}

/* ---------------- Durable Object ---------------- */

export class TickWatcher {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ws = null;
    this.connecting = false;
    this.nextTry = 0;
    this.backoff = 1000;
    this.reconnects = 0;
    this.connectedAt = 0;
    this.lastMsgAt = 0;
    this.lastTick = null;       // { bid, ask, price, at }
    this.prevBid = null;        // bid tick sebelumnya (dipakai shouldFire zona BUY)
    this.prevAsk = null;        // ask tick sebelumnya (dipakai shouldFire zona SELL)
    this.prevMid = null;        // mid tick sebelumnya (null = tick pertama setelah restart)
    this.retryAfter = new Map(); // zone_key -> timestamp: jangan coba kirim ulang sebelum ini
    this.announceRetryAfter = new Map(); // zone_key -> timestamp: jangan coba umumkan ulang sebelum ini
    this.lastAnnounce = null;    // hasil kirim pengumuman zona baru terakhir
    this.zones = [];
    this.zonesAt = 0;
    this.lastFlush = 0;
    this.skipped = null;
    this.triggered = new Set(); // zone_key yang sudah trigger (cermin D1)
    this.fresh = new Set();     // zone_key yang baru pertama kali dilihat
    this.busy = false;
    this.pending = null;
    this.lastError = null;
    this.lastFire = null;
    this.lastPush = null;
    this.samples = [];
  }

  get symbol() { return String(this.env.EXN_SYMBOL || "XAUUSD").toUpperCase(); }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/ensure") {
      await this.ensure().catch((e) => { this.lastError = String((e && e.message) || e); });
      await this.scheduleAlarm();
      return jsonRes(this.status());
    }
    if (path === "/refresh") {
      // Snapshot zona baru juga menjadi bootstrap koneksi Exness bila belum aktif.
      await this.ensure().catch((e) => { this.lastError = String((e && e.message) || e); });
      // Evaluasi segera terhadap tick terakhir setelah zona diperbarui.
      if (this.lastTick) {
        this.zonesAt = 0;
        this.queue(this.lastTick);
      }
      await this.scheduleAlarm();
      return jsonRes({ ok: true, connected: Boolean(this.ws), tickAgeSec: this.lastTick ? Math.round((Date.now() - this.lastTick.at) / 1000) : null });
    }
    if (path === "/status") return jsonRes(this.status());
    return new Response("not found", { status: 404 });
  }

  async alarm() {
    try { await this.ensure(); } catch (e) { this.lastError = String((e && e.message) || e); }
    await this.scheduleAlarm();
  }

  async scheduleAlarm() {
    if (!configured(this.env)) return;
    const wait = weekendClosed(Date.now()) ? 10 * 60 * 1000 : WATCHDOG_MS;
    try { await this.state.storage.setAlarm(Date.now() + wait); } catch { /* abaikan */ }
  }

  status() {
    const now = Date.now();
    return {
      configured: configured(this.env),
      symbol: this.symbol,
      weekend_closed: weekendClosed(now),
      connected: Boolean(this.ws),
      connected_for_sec: this.ws ? Math.round((now - this.connectedAt) / 1000) : null,
      tickAgeSec: this.lastTick ? Math.round((now - this.lastTick.at) / 1000) : null,
      last_msg_age_sec: this.lastMsgAt ? Math.round((now - this.lastMsgAt) / 1000) : null,
      price: this.lastTick ? this.lastTick.price : null,
      bid: this.lastTick ? this.lastTick.bid : null,
      ask: this.lastTick ? this.lastTick.ask : null,
      zones: this.zones.length,
      zones_skipped: this.skipped,
      triggered_known: this.triggered.size,
      reconnects: this.reconnects,
      last_error: this.lastError,
      last_fire: this.lastFire,
      last_push: this.lastPush,
      last_announce: this.lastAnnounce,
      sample_messages: this.samples,
    };
  }

  /* ----- koneksi ----- */

  closeSocket(reason) {
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(1000, reason); } catch { /* sudah tertutup */ } }
  }

  async ensure() {
    if (!configured(this.env)) { this.lastError = "exness-not-configured"; return; }
    const now = Date.now();
    if (weekendClosed(now)) {
      if (this.ws) { this.closeSocket("weekend"); this.prevBid = null; this.prevAsk = null; this.prevMid = null; }
      return;
    }
    if (this.ws && now - this.lastMsgAt > STALE_MS) { this.lastError = "stale: tidak ada pesan " + STALE_MS / 1000 + " dtk"; this.closeSocket("stale"); this.reconnects++; }
    if (this.ws || this.connecting || now < this.nextTry) return;
    await this.connect();
  }

  async accessPoint() {
    const fixed = normHost(this.env.EXN_ACCESS_POINT);
    if (fixed) return fixed;
    const cached = await this.state.storage.get("access_point");
    if (cached && Date.now() - cached.at < 6 * 3600 * 1000) return cached.host;

    let gw = String(this.env.EXN_GATEWAY_URL || "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//.test(gw)) gw = "https://" + gw;
    const path = `/v1/trading/access-point?account_id=${encodeURIComponent(this.env.EXN_ACCOUNT_ID)}`;
    const r = await fetch(gw + path, { headers: await signHeaders(this.env, "GET", path) });
    if (!r.ok) throw new Error(`discovery ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const host = normHost(j.access_point || j.host);
    if (!host) throw new Error("discovery: access_point kosong");
    await this.state.storage.put("access_point", { host, at: Date.now() });
    return host;
  }

  async connect() {
    this.connecting = true;
    try {
      const host = await this.accessPoint();
      const path = `/v1/server-events/accounts/${encodeURIComponent(this.env.EXN_ACCOUNT_ID)}/ws/ticks`;
      const resp = await fetch(`https://${host}${path}`, {
        headers: { Upgrade: "websocket", ...(await signHeaders(this.env, "GET", path)) },
      });
      const ws = resp.webSocket;
      if (!ws) {
        const body = (await resp.text().catch(() => "")).slice(0, 300);
        if (resp.status >= 400 && resp.status < 500) await this.state.storage.delete("access_point");
        throw new Error(`handshake ${resp.status}: ${body}`);
      }
      ws.accept();
      ws.addEventListener("message", (e) => this.onMessage(e));
      ws.addEventListener("close", () => this.onClose(ws));
      ws.addEventListener("error", () => this.onClose(ws));
      this.ws = ws;
      this.connectedAt = Date.now();
      this.lastMsgAt = Date.now();
      this.backoff = 1000;
      this.lastError = null;
      ws.send(JSON.stringify({ id: "ticks-1", subscribe: { event: "ticks", instruments: [this.symbol] } }));
    } catch (e) {
      this.lastError = String((e && e.message) || e);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      this.nextTry = Date.now() + this.backoff;
      console.log("EXNESS WS CONNECT GAGAL:", this.lastError);
    } finally {
      this.connecting = false;
    }
  }

  onClose(ws) {
    if (this.ws !== ws) return;
    this.ws = null;
    this.reconnects++;
    this.nextTry = Date.now() + 1000;
    try { ws.close(1000, "bye"); } catch { /* sudah tertutup */ }
    // sambung ulang cepat lewat alarm (alarm tetap jalan walau DO sempat tidur)
    this.state.storage.setAlarm(Date.now() + 1500).catch(() => {});
  }

  onMessage(e) {
    this.lastMsgAt = Date.now();
    let text;
    try { text = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data); } catch { return; }
    if (this.samples.length < 5) this.samples.push(text.slice(0, 400));
    let j;
    try { j = JSON.parse(text); } catch { return; }
    if (j && (j.error || j.error_message) && !extractTick(j, this.symbol)) this.lastError = "server: " + text.slice(0, 300);
    const t = extractTick(j, this.symbol);
    if (!t) return;
    this.lastTick = { ...t, at: Date.now() };
    this.queue(this.lastTick);
  }

  /* ----- pemrosesan tick (serial; tick yang menumpuk digabung ke yang terbaru) ----- */

  queue(tick) {
    this.pending = tick;
    if (this.busy) return;
    this.busy = true;
    (async () => {
      try {
        while (this.pending !== null) {
          const t = this.pending;
          this.pending = null;
          await this.process(t);
        }
      } catch (e) {
        this.lastError = "process: " + String((e && e.message) || e);
        console.log("TICK PROCESS ERROR:", this.lastError);
      } finally {
        this.busy = false;
      }
    })();
  }

  async reloadZones(now) {
    const db = getDb(this.env);
    if (!db) return;
    await ensureSchema(db);
    const { zones, skipped } = await loadActiveZones(db, baseSymbol(this.symbol));
    this.skipped = skipped || null;
    this.zonesAt = now;
    this.zones = zones;

    const { results } = await db.prepare("SELECT zone_key, triggered, trigger_price, triggered_at, last_seen FROM zone_trigger_state WHERE symbol=?").bind(SYMBOL).all();
    const rowMap = new Map(results.map((r) => [r.zone_key, r]));
    const rowKeys = new Set(rowMap.keys());
    this.triggered = new Set(results.filter((r) => r.triggered).map((r) => r.zone_key));

    // Zona yang sudah pernah diumumkan (persisten di D1 — DO restart tidak mengumumkan ulang).
    const { results: announcedRows } = await db.prepare("SELECT zone_key FROM zone_announcement_state WHERE symbol=?").bind(SYMBOL).all();
    const announced = new Set(announcedRows.map((r) => r.zone_key));

    const flush = now - this.lastFlush >= FLUSH_MS;
    const stmts = [];
    const toAnnounce = [];
    for (const z of zones) {
      // Migrasi aman dari key versi lama yang masih menyertakan lo|hi.
      // Jika zona pernah trigger dan catatannya masih aktif, bawa statusnya ke key stabil.
      if (!rowKeys.has(z.key)) {
        const legacyPrefix = z.key + "|";
        const legacy = results
          .filter((r) => r.zone_key.startsWith(legacyPrefix) && r.triggered && now - Number(r.last_seen || 0) <= STALE_AFTER_SEC * 1000)
          .sort((a, b) => Number(b.triggered_at || 0) - Number(a.triggered_at || 0))[0];
        if (legacy) {
          stmts.push(db.prepare(
            "INSERT OR IGNORE INTO zone_trigger_state (zone_key, symbol, triggered, trigger_price, triggered_at, last_seen) VALUES (?, ?, 1, ?, ?, ?)"
          ).bind(z.key, SYMBOL, legacy.trigger_price, legacy.triggered_at, now));
          rowKeys.add(z.key);
          this.triggered.add(z.key);
        }
      }
      const isNew = !rowKeys.has(z.key) && !this.fresh.has(z.key);
      if (isNew) this.fresh.add(z.key);
      if (isNew || (flush && !this.triggered.has(z.key))) stmts.push(seenStmt(db, z, now));
      // Pengumuman zona baru FRESH: sekali per zona. Syaratnya HANYA "belum tercatat
      // diumumkan di D1" + tidak sedang dalam jeda retry — sengaja TIDAK memakai
      // isNew: isNew hanya true pada reload pertama zona itu muncul, sedangkan baris
      // seenStmt di zone_trigger_state membuat isNew false pada reload berikutnya.
      // Kalau syaratnya isNew, zona yang gagal diumumkan tidak akan pernah dicoba
      // lagi (retryAfter jadi kode mati). Dengan syarat D1 ini, DO restart pun aman:
      // zona yang belum diumumkan akan diumumkan pada reload berikutnya.
      if (!announced.has(z.key) && (this.announceRetryAfter.get(z.key) || 0) <= now) toAnnounce.push(z);
    }
    if (flush) {
      this.lastFlush = now;
      // zona yang sudah hilang > 3 menit = siklus lama selesai
      stmts.push(db.prepare("DELETE FROM zone_trigger_state WHERE symbol=? AND last_seen < ?").bind(SYMBOL, now - STALE_AFTER_SEC * 1000));
      // zona yang sudah tidak ada di snapshot: hapus catatan pengumumannya supaya
      // kalau zona yang sama terbentuk lagi nanti, pengumuman bisa bunyi lagi.
      const currentKeys = zones.map((z) => z.key);
      if (currentKeys.length) {
        stmts.push(db.prepare(`DELETE FROM zone_announcement_state WHERE symbol=? AND zone_key NOT IN (${currentKeys.map(() => "?").join(",")})`).bind(SYMBOL, ...currentKeys));
      } else {
        stmts.push(db.prepare("DELETE FROM zone_announcement_state WHERE symbol=?").bind(SYMBOL));
      }
      // jaga last_seen zona yang sudah triggered supaya tidak terhapus selama zonanya masih aktif
      for (const z of zones) if (this.triggered.has(z.key)) stmts.push(seenStmt(db, z, now));
    }
    if (stmts.length) await db.batch(stmts);

    // Kirim pengumuman zona baru (fungsi commitNewZoneAndPush dulu dead code).
    // Catatan: kalau harga sudah di dalam zona baru itu, notif TRIGGERED bisa menyusul
    // beberapa detik kemudian dari process() — itu dua kejadian berbeda, bukan duplikat.
    if (toAnnounce.length) {
      try {
        const res = await commitNewZoneAndPush(this.env, db, toAnnounce, now);
        this.lastAnnounce = { at: now, zones: toAnnounce.map((z) => `${z.bias} ${z.tf} ${z.block}`), ...res };
        const sent = res.sent || 0;
        if (res.subscribers === 0 || sent > 0) {
          await db.batch(toAnnounce.map((z) => db.prepare(
            "INSERT OR REPLACE INTO zone_announcement_state (zone_key, symbol, announced_at) VALUES (?, ?, ?)"
          ).bind(z.key, SYMBOL, now)));
        } else {
          // Push gagal total padahal ada subscriber: jangan tandai announced,
          // coba lagi setelah jeda 60 detik (bukan hilang selamanya).
          for (const z of toAnnounce) this.announceRetryAfter.set(z.key, now + 60000);
        }
      } catch (e) {
        this.lastError = "announce: " + String((e && e.message) || e);
        console.log("NEW ZONE ANNOUNCE ERROR:", this.lastError);
      }
    }
  }

  async process(tick) {
    const db = getDb(this.env);
    if (!db) return;
    const now = Date.now();
    if (now - this.zonesAt >= ZONE_REFRESH_MS) await this.reloadZones(now);

    const prevBid = this.prevBid, prevAsk = this.prevAsk, prevMid = this.prevMid;
    const stmts = [], fired = [], resetStmts = [];
    for (const z of this.zones) {
      // Harga sisi zona: BUY dicek pakai bid, SELL pakai ask (dulu mid — selisih setengah
      // spread dari harga yang dipakai EA, jadi zona di dekat batas kadang fire kadang tidak).
      const sidePrice = z.bias === "BUY" ? tick.bid : tick.ask;
      if (this.triggered.has(z.key)) {
        // Reset: harga sudah keluar jauh dari zona -> zona boleh berbunyi lagi pada
        // sentuhan berikutnya. Jangan fire di tick yang sama dengan reset.
        if (sidePrice < z.lo - RESET_MARGIN || sidePrice > z.hi + RESET_MARGIN) {
          this.triggered.delete(z.key);
          this.retryAfter.delete(z.key);
          resetStmts.push(deleteTriggerStmt(db, z.key));
        }
        continue;
      }
      // Push gagal total sebelumnya: tunggu sampai retryAfter sebelum mencoba lagi.
      if ((this.retryAfter.get(z.key) || 0) > now) continue;
      // first juga true saat prevMid null (tick pertama setelah restart DO): zona yang
      // harganya sudah di dalam saat itu boleh langsung fire, bukan menunggu lintasan.
      const first = this.fresh.has(z.key) || prevMid === null;
      this.fresh.delete(z.key);
      const sidePrev = z.bias === "BUY" ? prevBid : prevAsk;
      if (shouldFire(z, sidePrice, sidePrev, first)) {
        fired.push(z);
        this.triggered.add(z.key);
        stmts.push(triggerStmt(db, z, tick.price, now));
      }
    }
    this.prevBid = tick.bid;
    this.prevAsk = tick.ask;
    this.prevMid = tick.price;
    if (resetStmts.length) await db.batch(resetStmts);
    if (!fired.length) return;

    this.lastFire = { at: now, price: tick.price, zones: fired.map((z) => `${z.bias} ${z.tf} ${z.block}`) };
    try {
      const result = await commitAndPush(this.env, db, stmts, fired, tick.price, now);
      this.lastPush = result;
      const sent = result.sent || 0, failed = result.failed || 0;
      if (result.subscribers > 0 && sent === 0 && failed > 0) {
        // Push gagal total padahal ada subscriber: lepas penanda supaya sentuhan ini
        // bisa dicoba lagi (setelah jeda 60 dtk), bukan hilang selamanya.
        // Kalau subscribers == 0, biarkan triggered — tidak ada yang perlu diberitahu.
        for (const z of fired) {
          this.triggered.delete(z.key);
          this.retryAfter.set(z.key, now + 60000);
        }
        await db.batch(fired.map((z) => deleteTriggerStmt(db, z.key)));
      }
    } catch (e) {
      // gagal tulis D1 -> lepas penanda supaya tick berikutnya mencoba lagi (jangan sampai alert hilang)
      for (const z of fired) this.triggered.delete(z.key);
      throw e;
    }
  }
}

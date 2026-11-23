// zones-endpoint.js
// Tambahan untuk Worker zona-a1-signal-api (Cloudflare Workers + D1).
//
// Pasang di Worker:
//   1) import { handleZones } from './zones-endpoint.js';
//   2) di fetch router, sebelum 404:
//        if (url.pathname === '/api/zones') return handleZones(request, env);
//
// Penyesuaian yang perlu dicek (tidak saya lihat dari sisi Worker kamu):
//   - Binding D1 dianggap `env.DB`. Kalau di wrangler.toml namanya lain, ganti DB_BINDING di bawah.
//   - Key EA dibaca dari secret `env.ZONES_API_KEY`, fallback `env.API_KEY`.
//     Isi dengan nilai yang sama dengan input ZP_ApiKey di EA (sebaiknya key terpisah dari key sinyal).
//   - Tabel dibuat otomatis saat pertama kali dipanggil (CREATE TABLE IF NOT EXISTS).

const DB_BINDING = 'DB';
const STALE_AFTER_SEC = 180;           // EA heartbeat tiap 60 dtk; lewat 180 dtk dianggap offline
const MAX_ZONES = 6;

const TF_GROUP = {
  M1: 'SCALP', M5: 'SCALP',
  M15: 'INTRADAY', M30: 'INTRADAY',
  H1: 'SWING', H4: 'SWING', D1: 'POSITION', W1: 'POSITION', MN1: 'POSITION'
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
  'Cache-Control': 'no-store',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function triggerKey(z, block, box) {
  const lo = Math.min(box.top, box.bottom), hi = Math.max(box.top, box.bottom);
  return `${z.chart_id || z.tf}|${z.tf}|${block}|${String(z.bias || '').toUpperCase()}|${lo}|${hi}`;
}

function cleanBox(b) {
  if (!b || typeof b !== 'object') return null;
  const top = num(b.top), bottom = num(b.bottom);
  if (top === null || bottom === null) return null;
  return { top, bottom };
}

function cleanZone(z) {
  if (!z || typeof z !== 'object') return null;
  const tf = String(z.tf || '').toUpperCase();
  if (!TF_GROUP[tf]) return null;
  const bias = ['BUY', 'SELL', 'WAIT'].includes(z.bias) ? z.bias : null;
  const swingTop = num(z.swing_top), swingBottom = num(z.swing_bottom);
  if (!bias || swingTop === null || swingBottom === null) return null;
  const br1 = cleanBox(z.br1), br2 = cleanBox(z.br2);
  if (!br1 && !br2) return null;
  return {
    tf,
    group: TF_GROUP[tf],               // group selalu ditentukan server, bukan dari kiriman EA
    bias,
    swing_top: swingTop,
    swing_bottom: swingBottom,
    swing_pts: num(z.swing_pts),
    status_br1: ['FRESH', 'USED', 'INVALID', 'TRIGGERED'].includes(z.status_br1) ? z.status_br1 : 'FRESH',
    status_br2: ['FRESH', 'USED', 'INVALID', 'TRIGGERED'].includes(z.status_br2) ? z.status_br2 : 'FRESH',
    br1,
    br2,
    chart_id: typeof z.chart_id === 'string' ? z.chart_id.slice(0, 32) : null,
  };
}

const validSymbol = (s) => typeof s === 'string' && /^[A-Za-z0-9._]{3,20}$/.test(s);

async function ensureTable(db) {
  await db
    .prepare(
      'CREATE TABLE IF NOT EXISTS zone_snapshots (symbol TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)'
    )
    .run();
}

export async function handleZones(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const db = env[DB_BINDING];
  if (!db) return json({ ok: false, error: 'D1 binding not found' }, 500);
  await ensureTable(db);

  // ---- POST: snapshot / unregister dari EA ----
  if (request.method === 'POST') {
    const expected = env.ZONES_API_KEY || env.API_KEY;
    if (!expected) return json({ ok: false, error: 'API key not configured' }, 500);
    if (request.headers.get('X-API-Key') !== expected) return json({ ok: false, error: 'unauthorized' }, 401);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'invalid json' }, 400);
    }

    const symbol = String(body.symbol || '').toUpperCase();
    if (!validSymbol(symbol)) return json({ ok: false, error: 'invalid symbol' }, 400);
    const now = Date.now();

    const previous = await db
      .prepare('SELECT payload FROM zone_snapshots WHERE symbol = ?1')
      .bind(symbol)
      .first();

    let existing = [];
    try {
      existing = previous ? JSON.parse(previous.payload) : [];
      if (!Array.isArray(existing)) existing = [];
    } catch {
      existing = [];
    }

    // Bersihkan snapshot kedaluwarsa terlebih dahulu (termasuk data versi lama).
    existing = existing.filter(z =>
      z && z.tf && Number.isFinite(Number(z.updated_at)) &&
      (now - Number(z.updated_at)) <= STALE_AFTER_SEC * 1000
    );

    if (body.action === 'unregister') {
      const tf = String(body.tf || '').toUpperCase();
      const chartId = String(body.chart_id || '');
      if (!TF_GROUP[tf] || !chartId) return json({ ok: false, error: 'invalid unregister payload' }, 400);

      // Cocokkan chart_id agar EA pada chart lain tidak ikut terhapus.
      // Entri legacy tanpa chart_id dibersihkan sebagai fallback satu kali.
      const before = existing.length;
      existing = existing.filter(z =>
        !(z.tf === tf && (!z.chart_id || String(z.chart_id) === chartId))
      );

      await db
        .prepare(
          'INSERT INTO zone_snapshots (symbol, payload, updated_at) VALUES (?1, ?2, ?3) ' +
            'ON CONFLICT(symbol) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at'
        )
        .bind(symbol, JSON.stringify(existing), now)
        .run();

      return json({ ok: true, action: 'unregister', symbol, tf, removed: before - existing.length, count: existing.length, updated_at: now });
    }

    if (!Array.isArray(body.zones) || body.zones.length > MAX_ZONES) {
      return json({ ok: false, error: 'invalid zones' }, 400);
    }

    const incoming = body.zones.map(cleanZone).filter(Boolean);
    const byTf = new Map(existing.filter(z => z && z.tf).map(z => [z.tf, z]));
    for (const zone of incoming) {
      byTf.set(zone.tf, { ...zone, updated_at: now });
    }
    const zones = Array.from(byTf.values()).slice(0, MAX_ZONES);

    await db
      .prepare(
        'INSERT INTO zone_snapshots (symbol, payload, updated_at) VALUES (?1, ?2, ?3) ' +
          'ON CONFLICT(symbol) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at'
      )
      .bind(symbol, JSON.stringify(zones), now)
      .run();
    return json({ ok: true, symbol, count: zones.length, updated_at: now });
  }

  // ---- GET: untuk dashboard ----
  if (request.method === 'GET') {
    const url = new URL(request.url);
    const symbol = String(url.searchParams.get('symbol') || 'XAUUSD').toUpperCase();
    if (!validSymbol(symbol)) return json({ ok: false, error: 'invalid symbol' }, 400);

    const row = await db
      .prepare('SELECT payload, updated_at FROM zone_snapshots WHERE symbol = ?1')
      .bind(symbol)
      .first();
    if (!row) return json({ ok: true, symbol, zones: [], updated_at: null, age_sec: null, stale: true });

    const ageSec = Math.max(0, Math.round((Date.now() - row.updated_at) / 1000));
    let zones = [];
    try {
      zones = JSON.parse(row.payload);
      if (!Array.isArray(zones)) zones = [];
      // Expire each timeframe independently; an active M1 must not keep old M15/H1 visible.
      zones = zones.filter(z =>
        z && Number.isFinite(Number(z.updated_at)) &&
        (Date.now() - Number(z.updated_at)) <= STALE_AFTER_SEC * 1000
      );
    } catch {
      zones = [];
    }
    // Status TRIGGERED berasal dari state persisten D1, bukan dari browser.
    try {
      await db.prepare('CREATE TABLE IF NOT EXISTS zone_trigger_state (zone_key TEXT PRIMARY KEY, symbol TEXT NOT NULL, triggered INTEGER NOT NULL DEFAULT 0, trigger_price REAL, triggered_at INTEGER, last_seen INTEGER NOT NULL)').run();
      const { results: states } = await db.prepare('SELECT zone_key, trigger_price, triggered_at FROM zone_trigger_state WHERE symbol = ?1 AND triggered = 1').bind(symbol).all();
      const triggered = new Map(states.map(x => [x.zone_key, x]));
      zones = zones.map(z => {
        const out = { ...z };
        for (const block of ['br1', 'br2']) {
          const box = out[block];
          if (!box) continue;
          const name = block.toUpperCase();
          const state = triggered.get(triggerKey(out, name, box));
          if (state && out['status_' + block] === 'FRESH') {
            out['status_' + block] = 'TRIGGERED';
            out['trigger_' + block] = { price: state.trigger_price, at: state.triggered_at };
          }
        }
        return out;
      });
    } catch (e) {
      // Jika migrasi state belum tersedia, dashboard tetap menerima snapshot EA seperti biasa.
    }
    return json({ ok: true, symbol, zones, updated_at: row.updated_at, age_sec: ageSec, stale: zones.length === 0 || ageSec > STALE_AFTER_SEC });
  }

  return json({ ok: false, error: 'method not allowed' }, 405);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, "Cache-Control": "no-store" },
  });
}

async function ensureTable(env) {
  if (!env.DB) return false;
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS site_visit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor_hash TEXT NOT NULL,
      page_path TEXT NOT NULL DEFAULT '/',
      ts INTEGER NOT NULL
    )
  `).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_site_visit_ts ON site_visit_log(ts)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_site_visit_hash ON site_visit_log(visitor_hash)").run();
  return true;
}

async function hashVisitor(visitorId) {
  const bytes = new TextEncoder().encode(visitorId);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function handleSiteAnalytics(request, env) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/site-visit" && url.pathname !== "/api/site-visit-stats") return null;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  try {
    await ensureTable(env);
    if (url.pathname === "/api/site-visit" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ ok: false, error: "invalid_json" }, 400); }
      const visitorId = String(body.visitorId || "");
      if (!/^[a-f0-9-]{30,40}$/i.test(visitorId)) return json({ ok: false, error: "invalid_visitor_id" }, 400);
      const pagePath = String(body.page || "/").slice(0, 180);
      const visitorHash = await hashVisitor(visitorId);
      await env.DB.prepare("INSERT INTO site_visit_log (visitor_hash, page_path, ts) VALUES (?, ?, ?)")
        .bind(visitorHash, pagePath, Date.now()).run();
      return json({ ok: true });
    }

    if (url.pathname === "/api/site-visit-stats" && request.method === "GET") {
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const weekStart = Date.now() - 6 * 86400000;
      const totals = await env.DB.prepare(`
        SELECT COUNT(*) AS visits,
               COUNT(DISTINCT visitor_hash) AS unique_visitors,
               SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS today_visits,
               COUNT(DISTINCT CASE WHEN ts >= ? THEN visitor_hash END) AS today_unique
        FROM site_visit_log
      `).bind(todayStart, todayStart).first();
      const daily = await env.DB.prepare(`
        SELECT date(ts / 1000, 'unixepoch') AS day,
               COUNT(*) AS visits,
               COUNT(DISTINCT visitor_hash) AS unique_visitors
        FROM site_visit_log WHERE ts >= ?
        GROUP BY date(ts / 1000, 'unixepoch') ORDER BY day ASC
      `).bind(weekStart).all();
      return json({
        ok: true,
        visits: Number(totals?.visits || 0),
        unique_visitors: Number(totals?.unique_visitors || 0),
        today_visits: Number(totals?.today_visits || 0),
        today_unique: Number(totals?.today_unique || 0),
        daily: (daily.results || []).map((r) => ({
          day: r.day, visits: Number(r.visits || 0), unique_visitors: Number(r.unique_visitors || 0),
        })),
        updated_at: new Date().toISOString(),
      });
    }
    return json({ ok: false, error: "method_not_allowed" }, 405);
  } catch (error) {
    return json({ ok: false, error: String(error?.message || error) }, 500);
  }
}

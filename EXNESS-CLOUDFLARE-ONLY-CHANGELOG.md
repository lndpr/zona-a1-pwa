# Exness Cloudflare-only update

- Uses Exness WebSocket ticks directly from Cloudflare Durable Object `TickWatcher`.
- No VPS bridge is required.
- Removed BiQuote quote polling and fallback from `push-alerts.js`.
- Cron now only bootstraps/checks the Exness watcher; it does not fetch market prices.
- EA `/api/zones` snapshots trigger watcher refresh and bootstrap.
- Existing frontend/PWA files and push subscription UI are retained.
- Requires Exness API credentials as Cloudflare secrets and a valid account DNS Gateway host.

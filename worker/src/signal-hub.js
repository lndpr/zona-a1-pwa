// Durable Object: singleton yang menangani koneksi realtime lewat
// WebSocket Hibernation API dan broadcast sinyal ke semua browser aktif.
//
// Kenapa WebSocket Hibernation, bukan SSE/TransformStream biasa:
// Cloudflare bisa "meng-evict" (tidurin) Durable Object yang nggak sibuk
// buat hemat resource. Dengan TransformStream biasa, daftar koneksi
// yang disimpan di memori (this.clients) ikut hilang saat di-evict —
// broadcast berikutnya nembak ke ruang kosong tanpa error apapun.
//
// WebSocket yang di-accept lewat state.acceptWebSocket() itu beda:
// Cloudflare sendiri yang nge-track koneksinya di level infrastruktur,
// independen dari memori instance. Jadi walau Durable Object-nya
// sempat di-evict dan "bangun" lagi (constructor jalan ulang),
// state.getWebSockets() tetap balikin semua koneksi yang masih aktif.

export class SignalHub {

  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {

    const url = new URL(request.url);

    // Browser subscribe realtime — upgrade ke WebSocket
    if (url.pathname === "/subscribe") {
      return this.handleSubscribe(request);
    }

    // Internal bootstrap endpoint: Cron only wakes the singleton monitor.
    if (url.pathname === "/monitor/start" && request.method === "POST") {
      const current = await this.state.storage.getAlarm();
      if (current === null) await this.state.storage.setAlarm(Date.now() + 1000);
      return new Response(JSON.stringify({ ok: true, alarm: current || Date.now() + 1000 }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Worker mengirim broadcast
    if (url.pathname === "/broadcast" && request.method === "POST") {
      const payload = await request.json();
      await this.broadcast(payload);
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }

  handleSubscribe(request) {

    const upgradeHeader = request.headers.get("Upgrade");

    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Kunci: acceptWebSocket (bukan server.accept() biasa) — ini yang
    // bikin koneksinya "hibernatable", tahan evict.
    this.state.acceptWebSocket(server);

    console.log("WS CLIENT ACCEPTED, total:", this.state.getWebSockets().length);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  // Dipanggil otomatis oleh runtime kalau client kirim pesan.
  // Browser kita nggak pernah kirim apa-apa, tapi handler ini wajib ada
  // supaya API hibernation-nya aktif dengan benar.
  async webSocketMessage(ws, message) {
    // no-op — cuma jaga-jaga kalau nanti ada ping dari client
  }

  async webSocketClose(ws, code, reason, wasClean) {
    try {
      ws.close(code, reason);
    } catch (e) {
      // socket mungkin sudah tertutup, aman diabaikan
    }
    console.log("WS CLOSED, sisa:", this.state.getWebSockets().length);
  }

  async webSocketError(ws, error) {
    console.log("WS ERROR:", error && error.message);
  }

  // SignalHub hanya menangani koneksi WebSocket browser.
  // Retry push zona ditangani oleh TickWatcher/push-alerts, bukan DO ini.
  // Alarm lama dari versi sebelumnya dibersihkan agar tidak memanggil
  // fungsi drainPushQueue yang memang tidak ada pada build Cloudflare-only.
  async alarm() {
    console.log("SignalHub legacy alarm: no push queue attached.");
  }

  async broadcast(payload) {

    const msg = JSON.stringify(payload);
    const sockets = this.state.getWebSockets();

    console.log("BROADCAST ke", sockets.length, "socket");

    for (const ws of sockets) {
      try {
        ws.send(msg);
      } catch (e) {
        console.log("SEND FAILED, socket kemungkinan sudah mati");
        // Nggak perlu manual delete — runtime yang urus siklus hidup socket
      }
    }
  }
}

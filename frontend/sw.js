/* ZONA A1 PWA Service Worker — preserves existing Worker Web Push flow. */
const CACHE_VERSION = "zona-a1-pwa-v4";
const APP_SHELL = [
  "./",
  "./index.html",
  "./offline.html",
  "./manifest.webmanifest",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/apple-touch-icon.png"
];
const API = "https://zona-a1-signal-api.landungprakoso14.workers.dev";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await Promise.all(APP_SHELL.map(async (path) => {
      try {
        const response = await fetch(path, { cache: "reload" });
        if (response.ok) await cache.put(path, response);
      } catch (_) { /* An optional shell asset must not block installation. */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith("zona-a1-pwa-") && key !== CACHE_VERSION)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Do not intercept Cloudflare Worker API calls or third-party feeds.
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          // Cache under the page's own URL — never overwrite the home page
          // with another page's content.
          await cache.put(request, response.clone());
        }
        return response;
      } catch (_) {
        return (await cache.match(request)) ||
          (await cache.match("./index.html")) ||
          (await cache.match("./offline.html")) || Response.error();
      }
    })());
    return;
  }

  // Cache same-origin static assets only; do not cache dynamic API responses.
  if (/\.(?:css|js|png|jpg|jpeg|webp|svg|woff2?)$/i.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(request);
      const networkPromise = fetch(request).then((response) => {
        if (response && response.ok) cache.put(request, response.clone());
        return response;
      }).catch(() => null);
      return cached || (await networkPromise) || Response.error();
    })());
  }
});

// Existing Web Push behavior: fetch the latest alert from the same Worker API.
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    // Teks cadangan NETRAL: jangan pernah menyebut kejadian spesifik. Teks lama
    // ("Harga masuk area blok BR1/BR2") tampil saat fetch /api/push/last gagal,
    // padahal alert yang dikirim bisa saja zona baru / news / tes — persis yang
    // terjadi 23 Nov 20:26: notif zona baru tampil sebagai "harga masuk area".
    let title = "ALERT ZONA A1";
    let body = "Ada alert baru dari ZONA A1. Buka dashboard untuk detail.";
    let tag = "a1-zone";
    // Ambil isi asli dari Worker: 2x percobaan, timeout 8 dtk tiap percobaan.
    // (Dulu 1x percobaan 3,5 dtk — di HP dengan sinyal lemot, fetch sering tidak
    // keburu dan notif tampil dengan teks cadangan yang menyesatkan.)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(API + "/api/push/last", { cache: "no-store", signal: AbortSignal.timeout(8000) });
        if (response.ok) {
          const payload = await response.json();
          if (payload && payload.title) {
            title = payload.title;
            body = payload.body || body;
            tag = payload.tag || tag;
            break;
          }
        }
      } catch (_) { /* Coba lagi sekali, lalu pakai teks cadangan netral. */ }
    }

    await self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      icon: "./assets/icons/icon-192.png",
      badge: "./assets/icons/icon-192.png",
      data: { url: "./#a1LiveZones" }
    });
  })());
});

// If the browser rotates the push subscription, re-subscribe automatically
// and send the new endpoint to the Worker so alerts keep arriving.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    try {
      const keyResponse = await fetch(API + "/api/push/key", { cache: "no-store" });
      if (!keyResponse.ok) return;
      const { key } = await keyResponse.json();
      if (!key) return;
      const padding = "=".repeat((4 - key.length % 4) % 4);
      const raw = atob((key + padding).replace(/-/g, "+").replace(/_/g, "/"));
      const applicationServerKey = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) applicationServerKey[i] = raw.charCodeAt(i);
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey
      });
      await fetch(API + "/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() })
      });
    } catch (_) { /* A failed re-subscribe must not break the worker. */ }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("navigate" in client) await client.navigate(target);
      if ("focus" in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});

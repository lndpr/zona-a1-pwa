/* ZONA A1 PWA Service Worker — preserves existing Worker Web Push flow. */
const CACHE_VERSION = "zona-a1-pwa-v3";
const APP_SHELL = [
  "/",
  "/index.html",
  "/offline.html",
  "/manifest.webmanifest",
  "/assets/icons/icon-192.png",
  "/assets/icons/icon-512.png",
  "/assets/icons/apple-touch-icon.png"
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
          await cache.put("/index.html", response.clone());
          await cache.put("/", response.clone());
        }
        return response;
      } catch (_) {
        return (await cache.match("/index.html")) ||
          (await cache.match("/")) ||
          (await cache.match("/offline.html")) || Response.error();
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
    let title = "ALERT ZONA A1";
    let body = "Harga masuk area blok BR1/BR2. Buka ZONA A1 untuk detail.";
    let tag = "a1-zone";
    try {
      // timeout 3,5 dtk: jangan sampai notif tertahan kalau Worker lambat — fallback ke teks bawaan
      const response = await fetch(API + "/api/push/last", { cache: "no-store", signal: AbortSignal.timeout(3500) });
      if (response.ok) {
        const payload = await response.json();
        if (payload && payload.title) {
          title = payload.title;
          body = payload.body || body;
          tag = payload.tag || tag;
        }
      }
    } catch (_) { /* Keep fallback notification text. */ }

    await self.registration.showNotification(title, {
      body,
      tag,
      renotify: true,
      icon: "/assets/icons/icon-192.png",
      badge: "/assets/icons/icon-192.png",
      data: { url: "/#a1LiveZones" }
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("navigate" in client) await client.navigate(target);
      if ("focus" in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});

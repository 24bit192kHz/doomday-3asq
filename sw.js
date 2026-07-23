// Doomday reader service worker — offline access to previously-visited manga and
// instant loads via stale-while-revalidate.
//
// Only same-origin GET requests are intercepted, so the catalog and per-manga JSON
// (and the app shell) are cached, while the actual page images — which stream from
// web.archive.org / archive.org (cross-origin) — always go straight to the network.
// Bump CACHE to invalidate every stored entry after a data-format change.
const CACHE = "doomday-v1";
const SHELL = [
  "index.html",
  "app.js",
  "style.css",
  "favicon.svg",
  "vendor/fflate.esm.js",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {})
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Never touch cross-origin requests (Wayback / Internet Archive image loads).
  if (url.origin !== location.origin) return;
  // Stale-while-revalidate: serve the cached copy immediately, refresh in background.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((resp) => {
          if (resp && resp.ok) cache.put(req, resp.clone());
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

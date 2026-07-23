// Doomday reader service worker — makes the archive readable offline and instant.
//
// Two caching strategies:
//  • App shell + catalog + per-manga JSON (same-origin): stale-while-revalidate, so
//    the library opens instantly but still picks up fresh archive data in the background.
//  • Wayback / Internet Archive images — covers AND chapter pages (cross-origin):
//    cache-first. These URLs are immutable (a given /web/<ts>id_/ or /download/ URL
//    always returns the same archived bytes), so serving from cache is always correct.
//    This is what stops covers from being re-fetched (and throttle-failing) on every
//    refresh: once seen, a cover loads straight from the browser cache, offline or not.
//
// Bump CACHE to invalidate every stored entry after a data-format change.
const CACHE = "doomday-v2";
const SHELL = [
  "index.html",
  "app.js",
  "style.css",
  "favicon.svg",
  "vendor/fflate.esm.js",
];

function isArchiveImage(url) {
  return (
    url.hostname === "web.archive.org" ||
    url.hostname === "archive.org" ||
    url.hostname.endsWith(".archive.org")
  );
}

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

  // Archived images (covers + pages): cache-first. After the first load they come
  // straight from the cache — no network, no Wayback rate-limit failures on refresh.
  if (isArchiveImage(url)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const resp = await fetch(req);
          // Cache real successes and opaque (no-cors) image responses. A cached
          // broken capture still degrades to the placeholder, same as uncached.
          if (resp && (resp.ok || resp.type === "opaque")) {
            cache.put(req, resp.clone());
          }
          return resp;
        } catch (err) {
          // Network failed and nothing cached — rethrow so the <img> error handler
          // shows the placeholder.
          throw err;
        }
      })
    );
    return;
  }

  // Same-origin (app shell, catalog, manga data): stale-while-revalidate.
  if (url.origin === location.origin) {
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
  }
});

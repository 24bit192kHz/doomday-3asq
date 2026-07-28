// Doomday reader service worker — makes the archive readable offline and instant.
//
// Three caching strategies keyed by URL class:
//  • App shell + catalog + per-manga JSON (same-origin): stale-while-revalidate, so
//    the library opens instantly but still picks up fresh archive data in the background.
//  • Immutable archive URLs — timestamped /web/<ts>id_/ captures and IA /download/
//    files: cache-first. A given URL always returns the same archived bytes, so
//    serving from cache is always correct, and it stops covers/pages from being
//    re-fetched (and throttle-failing) on every refresh.
//  • Mutable /web/2id_/ redirects ("latest capture"): network-first. These change
//    when the verifier repairs a capture, so cache-first would freeze the OLD
//    capture and hide the repair from returning readers. The cache is an
//    offline-only fallback here, and only resp.ok is stored (never an opaque
//    rate-limit interstitial, which would pin a broken capture forever).
//
// Bump CACHE to invalidate every stored entry after a data-format change.
const CACHE = "doomday-v5";
// Keep the ?v= in sync with index.html (it loads app.js?v=6 / style.css?v=6);
// a bare "app.js" precache key never matches the real request.
const SHELL = [
  "index.html",
  "app.js?v=6",
  "style.css?v=6",
  "favicon.svg",
  "vendor/fflate.esm.js",
];

// Classify a URL: "immutable" (timestamped capture / IA download), "latest"
// (2id_ redirect-to-latest), or null (don't cache — other Wayback endpoints such
// as availability/save and rate-limit interstitials).
function archivePolicy(url) {
  if (url.hostname === "web.archive.org") {
    if (/^\/web\/\d{6,14}[a-z]*_\//.test(url.pathname)) return "immutable";
    if (url.pathname.startsWith("/web/2id_/")) return "latest";
    return null;
  }
  if (url.hostname === "archive.org" || url.hostname.endsWith(".archive.org")) {
    return "immutable";
  }
  return null;
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
  const policy = archivePolicy(url);

  // Immutable captures: cache-first. After the first load they come straight from
  // the cache — no network, no Wayback rate-limit failures on refresh.
  if (policy === "immutable") {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const resp = await fetch(req);
        // Cache real successes and opaque (no-cors) image responses — <img> loads
        // are no-cors, so every image response is opaque; not caching them would
        // re-hit Wayback on every refresh. A cached broken capture still degrades
        // to the placeholder, same as uncached.
        if (resp && (resp.ok || resp.type === "opaque")) {
          cache.put(req, resp.clone());
        }
        return resp;
      })
    );
    return;
  }

  // 2id_ "latest capture" redirects are mutable: network-first so verifier
  // repairs reach returning readers; the cached copy is an offline-only fallback.
  if (policy === "latest") {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        try {
          const resp = await fetch(req);
          if (resp && resp.ok) cache.put(req, resp.clone());
          return resp;
        } catch (err) {
          const cached = await cache.match(req);
          if (cached) return cached;
          throw err; // offline + nothing cached -> <img> error -> placeholder
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
  // policy === null on web.archive.org (availability/save/interstitials): no
  // respondWith, so the browser does the default fetch and we never cache a
  // rate-limit interstitial.
});

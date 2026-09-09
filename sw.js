// Doomday reader service worker — makes the archive readable offline and instant.
//
// Caching strategies keyed by URL class:
//  • Same-origin versioned shell (app.js?v=, style.css?v=, vendor/): cache-first
//    (immutable per ?v=). Reader DATA (catalog.json.gz, m/<slug>.json.gz) and
//    page navigations: network-first, so a plain F5 always shows the latest
//    chapters — the cache is only the offline fallback for those.
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
// CACHE name is intentionally NOT bumped here: only the fetch strategy changed,
// not the data format, so keeping the name preserves every cached cover/page
// image. The sw.js byte change alone triggers the service-worker update.
const CACHE = "doomday-v7";
// Keep the ?v= in sync with index.html (it loads app.js?v=9 / style.css?v=9)
// and with app.js's register("sw.js?v=9"); a bare "app.js" precache key never
// matches the real request.
const SHELL = [
  "index.html",
  "app.js?v=9",
  "style.css?v=9",
  "favicon.svg",
  "vendor/fflate.esm.js",
];

// Versioned app-shell assets: immutable per ?v=, so they're safe to serve
// cache-first. Reader DATA (catalog.json.gz, m/<slug>.json.gz) is deliberately
// NOT in this set — it must be network-first so a plain F5 always shows the
// latest chapters instead of a stale cached copy.
function isShellAsset(pathname) {
  return (
    pathname.endsWith("/app.js") ||
    pathname.endsWith("/style.css") ||
    pathname.endsWith("/favicon.svg") ||
    pathname.includes("/vendor/")
  );
}

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

  // Same-origin.
  if (url.origin === location.origin) {
    // Page loads (F5, address bar): network-first. Stale-while-revalidate here
    // served a cached index.html pointing at old ?v= asset references, which
    // pinned readers on old app generations until a hard reload — the cache
    // copy now stays as the offline fallback only.
    if (req.mode === "navigate") {
      event.respondWith(
        caches.open(CACHE).then(async (cache) => {
          try {
            const resp = await fetch(req);
            if (resp && resp.ok) cache.put(req, resp.clone());
            return resp;
          } catch (err) {
            const cached = await cache.match(req);
            if (cached) return cached;
            throw err;
          }
        })
      );
      return;
    }
    // Versioned shell assets (app.js?v=, style.css?v=, vendor/): cache-first.
    // Content is immutable per ?v=, and a version bump changes the cache key.
    if (isShellAsset(url.pathname)) {
      event.respondWith(
        caches.open(CACHE).then(async (cache) => {
          const cached = await cache.match(req);
          if (cached) return cached;
          const resp = await fetch(req);
          if (resp && resp.ok) cache.put(req, resp.clone());
          return resp;
        })
      );
      return;
    }
    // Reader data (catalog.json.gz, m/<slug>.json.gz, status files): network-first.
    // A plain F5 must show fresh chapter lists; the cached copy is the offline
    // fallback only. Covers/pages stay cache-first via the immutable policy above.
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        try {
          const resp = await fetch(req);
          if (resp && resp.ok) cache.put(req, resp.clone());
          return resp;
        } catch (err) {
          const cached = await cache.match(req);
          if (cached) return cached;
          throw err;
        }
      })
    );
  }
  // policy === null on web.archive.org (availability/save/interstitials): no
  // respondWith, so the browser does the default fetch and we never cache a
  // rate-limit interstitial.
});

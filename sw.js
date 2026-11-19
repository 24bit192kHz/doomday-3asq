// Doomday reader service worker — makes the archive readable offline and instant.
//
// Two caches:
//  • CACHE ("doomday-vN", versioned): app shell + reader data. Bumping N drops every
//    older "doomday-v*" cache on activate.
//  • ASSET_CACHE ("archive-assets-v1", NOT versioned with the shell): archive
//    images (covers/pages). Count-capped at ASSET_MAX entries, oldest-first trim.
//
// Strategies keyed by URL class:
//  • Same-origin versioned shell (app.js?v=, style.css?v=, vendor/): cache-first
//    (immutable per ?v=). favicon.svg, reader DATA (catalog.json.gz,
//    m/<slug>.json.gz) and page navigations: network-first; the cache is only the
//    offline fallback for those.
//  • Immutable archive URLs — timestamped /web/<ts>id_/ captures and IA files:
//    cache-first.
//  • Mutable /web/2id_/ redirects ("latest capture"): network-first, cache is an
//    offline-only fallback (verifier repairs must reach returning readers).
//
// Opaque-response policy (applies to every branch): <img> loads are no-cors, so
// cross-origin image responses are opaque — status unknowable, and a Wayback
// 429/503 interstitial looks identical to a real image. The SW therefore NEVER
// stores an opaque response by itself. It holds the response briefly in memory
// (PENDING) and only commits it to ASSET_CACHE when app.js posts
// {type: "image-ok", url} from the <img> load event — i.e. the bytes decoded as an
// image. Non-opaque responses are stored only when resp.ok.
const CACHE = "doomday-v8";
const SHELL_PREFIX = "doomday-v";
const ASSET_CACHE = "archive-assets-v1";
const ASSET_MAX = 3000;
// Keep the ?v= in sync with index.html (app.js?v=12 / style.css?v=11) and with
// app.js's register("sw.js?v=12"); a bare "app.js" precache key never matches.
const SHELL = [
  "index.html",
  "app.js?v=12",
  "style.css?v=11",
  "favicon.svg",
  "vendor/fflate.esm.js",
];

// Opaque responses awaiting the page's load confirmation: url -> {resp, at}.
const PENDING = new Map();
const PENDING_MAX = 60;
const PENDING_TTL_MS = 2 * 60 * 1000;

// Versioned app-shell assets: immutable per ?v=, safe cache-first. favicon.svg
// has no ?v=, so it is network-first like reader data (it can change in place).
function isShellAsset(pathname) {
  return (
    pathname.endsWith("/app.js") ||
    pathname.endsWith("/style.css") ||
    pathname.includes("/vendor/")
  );
}

// "immutable" (timestamped capture / IA download), "latest" (2id_ redirect), or
// null (don't touch — availability/save endpoints, interstitials).
function archivePolicy(url) {
  if (url.protocol !== "https:") return null;
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

function holdPending(url, resp) {
  const now = Date.now();
  for (const [key, entry] of PENDING) {
    if (now - entry.at > PENDING_TTL_MS) PENDING.delete(key);
  }
  PENDING.delete(url);
  PENDING.set(url, { resp, at: now });
  while (PENDING.size > PENDING_MAX) PENDING.delete(PENDING.keys().next().value);
}

let putsSinceTrim = 0;
async function trimAssets(cache) {
  const keys = await cache.keys(); // insertion order: oldest first
  const excess = keys.length - ASSET_MAX;
  for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
}

async function putAsset(url, resp) {
  const cache = await caches.open(ASSET_CACHE);
  await cache.delete(url); // re-insert so the trim order tracks recent use
  await cache.put(url, resp);
  // cache.keys() over thousands of entries is not free: trim every 25 puts.
  if (++putsSinceTrim >= 25) {
    putsSinceTrim = 0;
    await trimAssets(cache);
  }
}

// Store a network response for an archive URL according to the opaque policy.
function storeArchiveResponse(req, resp) {
  if (!resp) return;
  if (resp.type === "opaque") {
    holdPending(req.url, resp.clone());
  } else if (resp.ok) {
    putAsset(req.url, resp.clone()).catch((err) => console.warn("sw: asset put failed", err));
  }
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      try {
        await cache.addAll(SHELL);
      } catch (err) {
        // addAll is all-or-nothing; fall back to per-file adds so one bad file
        // doesn't leave the whole shell uncached, and say which ones failed.
        console.warn("sw: shell precache failed, retrying per file", err);
        const results = await Promise.allSettled(SHELL.map((path) => cache.add(path)));
        results.forEach((r, i) => {
          if (r.status === "rejected") console.warn("sw: precache failed:", SHELL[i], r.reason);
        });
      }
    })
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            // Drop older shell versions and any pre-split cache that may hold
            // opaque responses pinned by the old policy; keep the image cache.
            .filter((k) => k !== CACHE && k !== ASSET_CACHE)
            .filter((k) => k.startsWith(SHELL_PREFIX) || k.startsWith("archive-assets-"))
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

// app.js confirms an archive image decoded successfully -> commit the held response.
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "image-ok" || typeof data.url !== "string") return;
  let url;
  try {
    url = new URL(data.url);
  } catch {
    return;
  }
  if (!archivePolicy(url)) return;
  const entry = PENDING.get(url.href);
  if (!entry) return; // SW restarted or already served from cache: nothing to commit
  PENDING.delete(url.href);
  event.waitUntil(
    putAsset(url.href, entry.resp).catch((err) => console.warn("sw: asset put failed", err))
  );
});

// Network-first against `cacheName`, storing only resp.ok (same-origin data/shell).
function networkFirst(req, cacheName, fallbackKey) {
  return caches.open(cacheName).then(async (cache) => {
    try {
      const resp = await fetch(req);
      if (resp && resp.ok) cache.put(req, resp.clone());
      return resp;
    } catch (err) {
      const cached = await cache.match(req);
      if (cached) return cached;
      if (fallbackKey) {
        const fallback = await cache.match(fallbackKey);
        if (fallback) return fallback;
      }
      throw err;
    }
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const policy = archivePolicy(url);

  // Immutable captures: cache-first (only confirmed-good bytes are ever cached).
  if (policy === "immutable") {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const resp = await fetch(req);
        storeArchiveResponse(req, resp);
        return resp;
      })
    );
    return;
  }

  // 2id_ "latest capture" redirects: network-first; cached copy is offline-only.
  if (policy === "latest") {
    event.respondWith(
      (async () => {
        try {
          const resp = await fetch(req);
          storeArchiveResponse(req, resp);
          return resp;
        } catch (err) {
          const cached = await caches.match(req, { cacheName: ASSET_CACHE });
          if (cached) return cached;
          throw err; // offline + nothing cached -> <img> error -> next candidate
        }
      })()
    );
    return;
  }

  if (url.origin === location.origin) {
    // Page loads: network-first; offline falls back to the precached index.html
    // (a directory request may carry its own cache key).
    if (req.mode === "navigate") {
      event.respondWith(networkFirst(req, CACHE, "index.html"));
      return;
    }
    // Versioned shell assets: cache-first (a ?v= bump changes the cache key).
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
    // Reader data, favicon, status files: network-first.
    event.respondWith(networkFirst(req, CACHE));
  }
  // Other Wayback endpoints (policy null): no respondWith -> default browser fetch,
  // nothing cached.
});

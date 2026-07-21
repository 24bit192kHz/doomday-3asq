// doomday-3asq reader — a tiny archive-only manga reader that streams every page
// from the Wayback Machine. No backend, no build step: just compressed JSON data.
const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app");
const crumb = $("#crumb");
const enc = encodeURIComponent;
const dec = decodeURIComponent;
const cache = new Map();

async function gunzip(bytes) {
  if (typeof DecompressionStream !== "undefined") {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  const { gunzipSync } = await import("./vendor/fflate.esm.js");
  return gunzipSync(new Uint8Array(bytes));
}

async function fetchGz(url) {
  if (cache.has(url)) return cache.get(url);
  const resp = await fetch(url, { cache: "force-cache" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} for ${url}`);
  const text = new TextDecoder().decode(await gunzip(await resp.arrayBuffer()));
  const data = JSON.parse(text);
  cache.set(url, data);
  return data;
}

function coverPlaceholder(title) {
  const div = document.createElement("div");
  div.className = "cover-ph";
  div.textContent = ((title || "?").trim().charAt(0) || "?").toUpperCase();
  return div;
}

function coverImg(url, title) {
  if (!url) return coverPlaceholder(title);
  const img = document.createElement("img");
  img.loading = "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.alt = title || "";
  img.src = url;
  img.addEventListener("error", () => img.replaceWith(coverPlaceholder(title)), { once: true });
  return img;
}

function navLink(href, label, enabled = true) {
  const a = document.createElement("a");
  a.textContent = label;
  if (enabled && href) a.href = href;
  else a.className = "disabled";
  return a;
}

// ---- Library ----

async function renderLibrary() {
  crumb.textContent = "";
  app.replaceChildren(Object.assign(document.createElement("div"), { className: "loading", textContent: "Loading library…" }));
  let data;
  try {
    data = await fetchGz("catalog.json.gz");
  } catch (error) {
    app.replaceChildren(Object.assign(document.createElement("div"), { className: "empty", textContent: `Failed to load catalog: ${error.message}` }));
    return;
  }
  const { stats, manga } = data;
  const wrap = document.createElement("div");
  wrap.className = "library";
  const hero = document.createElement("div");
  hero.className = "hero";
  hero.innerHTML = `
    <h1>3asq doomsday archive</h1>
    <p class="sub">Every manga preserved in the Wayback Machine — readable even if the site disappears.</p>
    <div class="stats">
      <span><b>${stats.manga}</b> manga</span>
      <span><b>${stats.chapters.toLocaleString()}</b> chapters</span>
      <span><b>${stats.archived.toLocaleString()}</b> pages archived</span>
    </div>`;
  const search = document.createElement("input");
  search.className = "search";
  search.type = "search";
  search.placeholder = `Search ${stats.manga} titles…`;
  hero.append(search);
  const grid = document.createElement("div");
  grid.className = "grid";
  wrap.append(hero, grid);
  app.replaceChildren(wrap);

  const render = (filter) => {
    const q = (filter || "").trim().toLowerCase();
    const list = q ? manga.filter((m) => (m.title || "").toLowerCase().includes(q)) : manga;
    grid.replaceChildren(...list.map(card));
    if (!list.length) {
      grid.replaceChildren(Object.assign(document.createElement("div"), { className: "empty", textContent: "No matches." }));
    }
  };
  render("");
  search.addEventListener("input", (e) => render(e.target.value));
}

function card(m) {
  const a = document.createElement("a");
  a.className = "card";
  a.href = `#/manga/${enc(m.slug)}`;
  const cover = document.createElement("div");
  cover.className = "card-cover";
  cover.append(coverImg(m.cover, m.title));
  const body = document.createElement("div");
  body.className = "card-body";
  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = m.title || m.slug;
  const meta = document.createElement("div");
  meta.className = "card-meta";
  meta.textContent = `${m.chapters} chapters`;
  body.append(title, meta);
  a.append(cover, body);
  return a;
}

// ---- Manga (chapter list) ----

async function renderManga(slug) {
  crumb.textContent = "";
  app.replaceChildren(Object.assign(document.createElement("div"), { className: "loading", textContent: "Loading…" }));
  let data;
  try {
    data = await fetchGz(`m/${enc(slug)}.json.gz`);
  } catch (error) {
    app.replaceChildren(Object.assign(document.createElement("div"), { className: "empty", textContent: `Failed to load manga: ${error.message}` }));
    return;
  }
  const { title, cover, chapters } = data;
  crumb.textContent = title;
  const wrap = document.createElement("div");
  wrap.className = "manga";
  const head = document.createElement("div");
  head.className = "manga-head";
  const cv = document.createElement("div");
  cv.className = "manga-cover";
  cv.append(coverImg(cover, title));
  const info = document.createElement("div");
  info.className = "manga-info";
  const h = document.createElement("h1");
  h.textContent = title;
  const meta = document.createElement("p");
  meta.className = "sub";
  meta.textContent = `${chapters.length} chapters`;
  const back = document.createElement("a");
  back.className = "backlink";
  back.href = "#/";
  back.textContent = "← library";
  info.append(h, meta, back);
  head.append(cv, info);

  const list = document.createElement("div");
  list.className = "chapters";
  for (const ch of [...chapters].reverse()) {
    const a = document.createElement("a");
    a.className = "chapter";
    a.href = `#/manga/${enc(slug)}/${enc(ch.id)}`;
    const label = document.createElement("span");
    label.textContent = ch.title || ch.id;
    const count = document.createElement("span");
    count.className = "ch-count";
    count.textContent = `${(ch.imgs || []).length}p`;
    a.append(label, count);
    list.append(a);
  }
  wrap.append(head, list);
  app.replaceChildren(wrap);
  window.scrollTo(0, 0);
}

// ---- Reader ----

async function renderReader(slug, chapterId) {
  crumb.textContent = "";
  app.replaceChildren(Object.assign(document.createElement("div"), { className: "loading", textContent: "Loading chapter…" }));
  let data;
  try {
    data = await fetchGz(`m/${enc(slug)}.json.gz`);
  } catch (error) {
    app.replaceChildren(Object.assign(document.createElement("div"), { className: "empty", textContent: `Failed to load manga: ${error.message}` }));
    return;
  }
  const { title, chapters } = data;
  const idx = chapters.findIndex((c) => c.id === chapterId);
  if (idx < 0) {
    app.replaceChildren(Object.assign(document.createElement("div"), { className: "empty", textContent: "Chapter not found." }));
    return;
  }
  const ch = chapters[idx];
  const prev = chapters[idx - 1];
  const next = chapters[idx + 1];
  crumb.textContent = `${title} — ${ch.title || ch.id}`;
  const mangaHref = `#/manga/${enc(slug)}`;

  const wrap = document.createElement("div");
  wrap.className = "reader";
  const bar = document.createElement("div");
  bar.className = "reader-bar";
  const back = document.createElement("a");
  back.href = mangaHref;
  back.textContent = "← chapters";
  const ttl = document.createElement("span");
  ttl.className = "reader-title";
  ttl.textContent = ch.title || ch.id;
  bar.append(
    navLink(prev && `#/manga/${enc(slug)}/${enc(prev.id)}`, "‹ prev", !!prev),
    back,
    ttl,
    navLink(next && `#/manga/${enc(slug)}/${enc(next.id)}`, "next ›", !!next)
  );

  const strip = document.createElement("div");
  strip.className = "strip";
  (ch.imgs || []).forEach((url, i) => {
    const holder = document.createElement("div");
    holder.className = "page";
    if (url) {
      const img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.alt = `page ${i + 1}`;
      img.src = url;
      img.addEventListener("error", () => {
        holder.classList.add("missing");
        holder.textContent = `page ${i + 1} unavailable`;
      }, { once: true });
      holder.append(img);
    } else {
      holder.classList.add("missing");
      holder.textContent = `page ${i + 1} not archived yet`;
    }
    strip.append(holder);
  });

  const bottom = document.createElement("div");
  bottom.className = "reader-bar bottom";
  bottom.append(
    navLink(prev && `#/manga/${enc(slug)}/${enc(prev.id)}`, "‹ previous chapter", !!prev),
    navLink(next && `#/manga/${enc(slug)}/${enc(next.id)}`, "next chapter ›", !!next)
  );

  wrap.append(bar, strip, bottom);
  app.replaceChildren(wrap);
  window.scrollTo(0, 0);
}

// ---- Router ----

async function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter((p) => p !== "");
  try {
    if (parts[0] === "manga" && parts.length >= 2) {
      const slug = dec(parts[1]);
      if (parts.length >= 3) await renderReader(slug, dec(parts[2]));
      else await renderManga(slug);
    } else {
      await renderLibrary();
    }
  } catch (error) {
    app.replaceChildren(Object.assign(document.createElement("div"), { className: "empty", textContent: `Error: ${error.message}` }));
  }
}

window.addEventListener("hashchange", route);
route();

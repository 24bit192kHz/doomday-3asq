// أرشيف مانجا العاشق — قارئ محفوظ يبثّ الصفحات من Wayback Machine.
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
  // no-cache: revalidate so new chapters/updates are picked up (304 when unchanged).
  const resp = await fetch(url, { cache: "no-cache" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const text = new TextDecoder().decode(await gunzip(await resp.arrayBuffer()));
  const data = JSON.parse(text);
  cache.set(url, data);
  return data;
}

// "منذ …" relative time from an ISO date (like the source site).
function relTime(iso) {
  if (!iso) return "";
  const then = new Date(iso + "T00:00:00Z").getTime();
  if (Number.isNaN(then)) return "";
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days < 0) return "قريبًا";
  if (days === 0) return "اليوم";
  if (days === 1) return "منذ يوم";
  if (days === 2) return "منذ يومين";
  if (days <= 10) return `منذ ${days} أيام`;
  if (days < 30) return `منذ ${days} يوم`;
  if (days < 60) return "منذ شهر";
  if (days < 365) return `منذ ${Math.floor(days / 30)} أشهر`;
  if (days < 730) return "منذ سنة";
  return `منذ ${Math.floor(days / 365)} سنوات`;
}

function fmtViews(views) {
  if (!views) return "";
  return views;
}

// تحميل كسول للأغلفة: لا يُطلَب الغلاف من الشبكة إلا عندما يقترب من نافذة العرض،
// فتُفتح المكتبة فورًا وتُحمَّل الأغلفة التي يراها القارئ أولًا فقط (بدل ٣٩١ طلبًا دفعة واحدة).
const coverObserver = ("IntersectionObserver" in window)
  ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        coverObserver.unobserve(img);
        img.src = img.dataset.src;
      }
    }, { rootMargin: "480px 0px", threshold: 0.01 })
  : null;

function coverPlaceholder(title) {
  const div = document.createElement("div");
  div.className = "cover-ph";
  div.textContent = ((title || "؟").trim().charAt(0) || "؟");
  return div;
}

function coverImg(url, title, cls) {
  const img = document.createElement("img");
  img.alt = cls === "cover-fg" ? (title || "") : "";
  img.referrerPolicy = "no-referrer";
  img.decoding = "async";
  if (cls) img.className = cls;
  img.dataset.src = url;
  img.addEventListener("load", () => img.classList.add("loaded"), { once: true });
  img.addEventListener("error", () => img.remove(), { once: true });
  if (coverObserver) {
    coverObserver.observe(img);
  } else {
    img.loading = "lazy";
    img.src = url;
  }
  return img;
}

// طبقة الغلاف: عنصر نائب (حرف العنوان) يظهر فورًا، ثم خلفية ضبابية بألوان الغلاف
// نفسه تملأ الإطار، وفوقها الغلاف الفعلي كاملًا دون قصّ (contain). بعض الأغلفة
// المخزّنة هي لافتات og:image أفقية (1200×630)، فلو قصصناها لتعبئة الإطار لبدت
// مقرّبة/مبتورة؛ الخلفية الضبابية تملأ الفراغ بأناقة بدل البتر.
function coverBlock(url, title) {
  const frag = document.createDocumentFragment();
  frag.append(coverPlaceholder(title));
  if (url) {
    frag.append(coverImg(url, title, "cover-bg"));
    frag.append(coverImg(url, title, "cover-fg"));
  }
  return frag;
}

function navLink(href, label, enabled = true) {
  const a = document.createElement("a");
  a.textContent = label;
  if (enabled && href) a.href = href;
  else a.className = "disabled";
  return a;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---------- المكتبة ----------

async function renderLibrary() {
  crumb.textContent = "";
  app.replaceChildren(el("div", "loading", "جارٍ تحميل المكتبة…"));
  let data;
  try {
    data = await fetchGz("catalog.json.gz");
  } catch (error) {
    app.replaceChildren(el("div", "empty", `تعذّر تحميل الفهرس: ${error.message}`));
    return;
  }
  const { stats, manga } = data;

  const head = el("div", "lib-head");
  const h1 = el("h1");
  h1.innerHTML = 'مانجا <span>العاشق</span> — الأرشيف';
  const sub = el("p", "lib-sub", "نسخة محفوظة كاملة من الموقع، تُقرأ حتى لو اختفى الموقع الأصلي.");
  const titleWrap = el("div");
  titleWrap.append(h1, sub);
  head.append(titleWrap);

  const statsRow = el("div", "stats");
  statsRow.append(
    statChip(stats.manga, "مانجا"),
    statChip(stats.chapters.toLocaleString("ar-EG"), "فصل"),
    statChip(stats.archived.toLocaleString("ar-EG"), "صفحة محفوظة")
  );

  const search = document.createElement("input");
  search.className = "search";
  search.type = "search";
  search.placeholder = `ابحث في ${stats.manga} مانجا…`;

  const grid = el("div", "grid");
  app.replaceChildren(head, statsRow, search, grid);

  const render = (filter) => {
    const q = (filter || "").trim().toLowerCase();
    const list = q ? manga.filter((m) => (m.title || "").toLowerCase().includes(q)) : manga;
    grid.replaceChildren(...list.map(card));
    if (!list.length) grid.replaceChildren(el("div", "empty", "لا نتائج."));
  };
  render("");
  search.addEventListener("input", (e) => render(e.target.value));
}

function statChip(value, label) {
  const chip = el("div", "stat");
  chip.append(el("b", null, value), document.createTextNode(label));
  return chip;
}

function card(m) {
  const a = el("a", "card");
  a.href = `#/manga/${enc(m.slug)}`;
  const cover = el("div", "card-cover");
  cover.append(coverBlock(m.cover, m.title));
  if (m.last) cover.append(el("div", "card-badge", `الفصل ${m.last}`));
  const body = el("div", "card-body");
  body.append(el("div", "card-title", m.title || m.slug));
  const meta = el("div", "card-meta");
  if (m.updated) {
    meta.append(el("span", "hot", relTime(m.updated)), document.createTextNode(" · "));
  }
  meta.append(document.createTextNode(`${m.chapters} فصل`));
  body.append(meta);
  a.append(cover, body);
  return a;
}

// ---------- صفحة المانجا ----------

async function renderManga(slug) {
  crumb.textContent = "";
  app.replaceChildren(el("div", "loading", "جارٍ التحميل…"));
  let data;
  try {
    data = await fetchGz(`m/${enc(slug)}.json.gz`);
  } catch (error) {
    app.replaceChildren(el("div", "empty", `تعذّر تحميل المانجا: ${error.message}`));
    return;
  }
  const { title, cover, updated, chapters } = data;
  crumb.textContent = title;

  const hero = el("div", "manga-hero");
  const cv = el("div", "manga-cover");
  cv.append(coverBlock(cover, title));
  const info = el("div", "manga-info");
  info.append(el("h1", null, title));
  const tags = el("div", "manga-tags");
  tags.append(el("span", "tag", `${chapters.length} فصل`));
  if (updated) tags.append(el("span", "tag", `آخر تحديث ${relTime(updated)}`));
  tags.append(el("span", "tag neutral", "محفوظ في Wayback"));
  const back = el("a", "backlink", "← المكتبة");
  back.href = "#/";
  info.append(tags, back);
  hero.append(cv, info);

  const list = el("div", "chapters");
  // الأحدث أولًا كما في الموقع الأصلي
  for (const ch of [...chapters].reverse()) {
    const a = el("a", "chapter");
    a.href = `#/manga/${enc(slug)}/${enc(ch.id)}`;
    const titleSpan = el("span", "ch-title", ch.title || ch.id);
    const side = el("span", "ch-side");
    if (ch.iso && isRecent(ch.iso)) side.append(el("span", "ch-new", "جديد"));
    if (ch.views) side.append(el("span", "ch-views", `👁 ${fmtViews(ch.views)}`));
    if (ch.date) side.append(el("span", "ch-date", ch.date));
    a.append(titleSpan, side);
    list.append(a);
  }

  app.replaceChildren(hero, list);
  window.scrollTo(0, 0);
}

function isRecent(iso) {
  const then = new Date(iso + "T00:00:00Z").getTime();
  return !Number.isNaN(then) && Date.now() - then < 7 * 86400000;
}

// ---------- القارئ ----------

async function renderReader(slug, chapterId) {
  crumb.textContent = "";
  app.replaceChildren(el("div", "loading", "جارٍ تحميل الفصل…"));
  let data;
  try {
    data = await fetchGz(`m/${enc(slug)}.json.gz`);
  } catch (error) {
    app.replaceChildren(el("div", "empty", `تعذّر تحميل المانجا: ${error.message}`));
    return;
  }
  const { title, chapters } = data;
  const idx = chapters.findIndex((c) => c.id === chapterId);
  if (idx < 0) {
    app.replaceChildren(el("div", "empty", "الفصل غير موجود."));
    return;
  }
  const ch = chapters[idx];
  const prev = chapters[idx - 1];
  const next = chapters[idx + 1];
  crumb.textContent = `${title} — ${ch.title || ch.id}`;
  const chHref = (c) => c && `#/manga/${enc(slug)}/${enc(c.id)}`;

  const bar = el("div", "reader-bar");
  const back = el("a", null, "← الفصول");
  back.href = `#/manga/${enc(slug)}`;
  bar.append(
    navLink(chHref(prev), "‹ السابق", !!prev),
    back,
    el("span", "reader-title", `${ch.title || ch.id}${ch.views ? " · 👁 " + fmtViews(ch.views) : ""}`),
    navLink(chHref(next), "التالي ›", !!next)
  );

  const strip = el("div", "strip");
  (ch.imgs || []).forEach((url, i) => strip.append(pageHolder(url, i + 1)));

  const bottom = el("div", "reader-bar bottom");
  bottom.append(
    navLink(chHref(prev), "‹ الفصل السابق", !!prev),
    navLink(chHref(next), "الفصل التالي ›", !!next)
  );

  app.replaceChildren(bar, strip, bottom);
  window.scrollTo(0, 0);
}

// صفحة واحدة: جرّب أحدث لقطة في Wayback (2id_)، ثم اللقطة المخزّنة، ثم عنصر نائب.
// النسخ المُستضافة (المنقذة من الحذف) تُحمَّل مباشرة؛ لا يمكن الرجوع للموقع الأصلي لأنه يمنع التحميل عبر المواقع.
function pageHolder(url, num) {
  const holder = el("div", "page");
  if (!url) {
    holder.classList.add("missing");
    holder.textContent = `الصفحة ${num} غير محفوظة`;
    return holder;
  }
  let candidates;
  if (url.includes("web.archive.org")) {
    const original = originalOf(url);
    candidates = original
      ? [...new Set([`https://web.archive.org/web/2id_/${original}`, url])]
      : [url];
  } else if (/3asq\.|imgur\.com/.test(url)) {
    // رابط أصلي حي (محجوب عبر المواقع): لا يفيد إلا لقطة Wayback
    candidates = [`https://web.archive.org/web/2id_/${url}`];
  } else {
    // نسخة منقذة مستضافة (GitHub/IA): حمّلها مباشرة
    candidates = [url];
  }
  loadImageChain(holder, candidates, num);
  return holder;
}

function loadImageChain(holder, candidates, num) {
  if (!candidates.length) {
    holder.classList.add("missing");
    holder.textContent = `الصفحة ${num} غير متاحة`;
    return;
  }
  const [src, ...rest] = candidates;
  const img = document.createElement("img");
  img.loading = "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.alt = `الصفحة ${num}`;
  img.addEventListener("error", () => {
    img.remove();
    loadImageChain(holder, rest, num);
  }, { once: true });
  img.src = src;
  holder.append(img);
}

// يستخرج الرابط الأصلي من رابط Wayback (للرجوع إليه عند غياب الأرشيف).
function originalOf(url) {
  const m = url.match(/^https:\/\/web\.archive\.org\/web\/\d+(?:[a-z]+_)?\/(.+)$/);
  return m ? m[1] : null;
}

// ---------- الموجّه ----------

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
    app.replaceChildren(el("div", "empty", `خطأ: ${error.message}`));
  }
}

window.addEventListener("hashchange", route);
route();

// Offline support: cache the app shell and visited manga data (stale-while-revalidate
// in sw.js). Page images still stream from the Wayback Machine. Registration is
// defensive — if it fails (unsupported browser, scope issue) the reader works normally.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// ============================================================
// iOS 26 - Minimal Reader (FB2)
// ============================================================

const BOOK = {
  // Сначала пробуем .fb2, потом .fb2.zip
  candidates: ["books/book.fb2", "books/book.fb2.zip"],
  fallbackTitle: "Книга",
  storageKey: "reader.fb2",
};

// --- DOM -------------------------------------------------------
const $ = (id) => document.getElementById(id);
const contentEl = $("content");
const loadingEl = $("loading");
const errorEl = $("error");
const prevBtn = $("prevBtn");
const nextBtn = $("nextBtn");
const pageNumEl = $("pageNum");
const pageCountEl = $("pageCount");
const themeToggle = $("themeToggle");
const bookTitle = $("bookTitle");
const bookAuthor = $("bookAuthor");
const selectionToolbar = $("selectionToolbar");
const bookmarkBtn = $("bookmarkBtn");
const jumpBtn = $("jumpBtn");
const navDivider = $("navDivider");
const toast = $("toast");
const toastText = $("toastText");

// --- Theme -----------------------------------------------------
const THEME_KEY = "reader.theme";

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "dark" || saved === "light") {
    applyTheme(saved);
    return;
  }
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(prefersDark ? "dark" : "light");
}

themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  const next = current === "dark" ? "light" : "dark";
  applyTheme(next);
  localStorage.setItem(THEME_KEY, next);
});

initTheme();

// --- State -----------------------------------------------------
let chapters = [];
let currentChapter = 0;
let isScrollingProgrammatically = false;

// --- File loading ----------------------------------------------
async function fetchBook() {
  let lastErr;
  for (const url of BOOK.candidates) {
    try {
      const res = await fetch(url);
      if (!res.ok) { lastErr = new Error(`${res.status}`); continue; }
      const lower = url.toLowerCase();
      if (lower.endsWith(".zip")) {
        const blob = await res.blob();
        // eslint-disable-next-line no-undef
        const zip = await JSZip.loadAsync(blob);
        const fb2Name = Object.keys(zip.files).find((n) =>
          n.toLowerCase().endsWith(".fb2")
        );
        if (!fb2Name) { lastErr = new Error("no .fb2 inside zip"); continue; }
        return await zip.files[fb2Name].async("string");
      }
      const buf = await res.arrayBuffer();
      return decodeText(buf);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("not found");
}

function decodeText(buf) {
  const u8 = new Uint8Array(buf);
  // BOM
  if (u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) {
    return new TextDecoder("utf-8").decode(buf);
  }
  if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) {
    return new TextDecoder("utf-16le").decode(buf);
  }
  if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) {
    return new TextDecoder("utf-16be").decode(buf);
  }
  // XML declaration sniff
  const headLen = Math.min(256, buf.byteLength);
  const head = new TextDecoder("ascii", { fatal: false }).decode(
    new Uint8Array(buf, 0, headLen)
  );
  const m = head.match(/encoding\s*=\s*["']([^"']+)["']/i);
  let enc = (m ? m[1] : "utf-8").toLowerCase().replace(/_/g, "-");
  if (enc === "cp1251" || enc === "win-1251") enc = "windows-1251";
  if (enc === "cp1252") enc = "windows-1252";
  try {
    return new TextDecoder(enc, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

// --- FB2 parsing -----------------------------------------------
function parseFB2(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");

  if (doc.getElementsByTagName("parsererror").length) {
    throw new Error("FB2: ошибка XML");
  }

  // Binaries (images, etc.)
  const binaries = {};
  for (const bin of doc.getElementsByTagName("binary")) {
    const id = bin.getAttribute("id");
    const type = bin.getAttribute("content-type") || "image/jpeg";
    if (id) {
      const base64 = bin.textContent.replace(/\s+/g, "");
      binaries[id] = `data:${type};base64,${base64}`;
    }
  }

  // Metadata
  const titleEl = doc.getElementsByTagName("book-title")[0];
  const title = titleEl ? titleEl.textContent.trim() : BOOK.fallbackTitle;

  let author = "";
  const titleInfo = doc.getElementsByTagName("title-info")[0];
  if (titleInfo) {
    const authorEl = titleInfo.getElementsByTagName("author")[0];
    if (authorEl) {
      const fn = authorEl.getElementsByTagName("first-name")[0]?.textContent || "";
      const mn = authorEl.getElementsByTagName("middle-name")[0]?.textContent || "";
      const ln = authorEl.getElementsByTagName("last-name")[0]?.textContent || "";
      author = [fn, mn, ln].filter(Boolean).join(" ").trim();
    }
  }

  // Cover
  let cover = null;
  const coverpage = doc.getElementsByTagName("coverpage")[0];
  if (coverpage) {
    const img = coverpage.getElementsByTagName("image")[0];
    if (img) {
      const href = getXlinkHref(img);
      if (href && href.startsWith("#")) cover = binaries[href.slice(1)] || null;
    }
  }

  // Body (first body is main; subsequent могут быть примечания)
  const body = doc.getElementsByTagName("body")[0];
  return { title, author, cover, body, binaries };
}

function getXlinkHref(el) {
  return (
    el.getAttributeNS("http://www.w3.org/1999/xlink", "href") ||
    el.getAttribute("xlink:href") ||
    el.getAttribute("l:href") ||
    el.getAttribute("href") ||
    ""
  );
}

// --- FB2 → HTML rendering --------------------------------------
function renderElement(el, binaries, depth = 0) {
  const local = el.localName || el.tagName.toLowerCase();

  const wrap = (tag, cls) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    appendChildren(node, el, binaries, depth + 1);
    return node;
  };

  switch (local) {
    case "section": return wrap("section", "fb2-section");
    case "title": {
      // Глубина заголовка зависит от вложенности
      const tag = depth <= 1 ? "h1" : depth === 2 ? "h2" : "h3";
      return wrap(tag, "fb2-title");
    }
    case "subtitle": return wrap("h4", "fb2-subtitle");
    case "p": return wrap("p", "");
    case "emphasis": return wrap("em", "");
    case "strong": return wrap("strong", "");
    case "epigraph": return wrap("blockquote", "fb2-epigraph");
    case "text-author": return wrap("div", "fb2-text-author");
    case "cite": return wrap("blockquote", "fb2-cite");
    case "poem": return wrap("div", "fb2-poem");
    case "stanza": return wrap("div", "fb2-stanza");
    case "v": return wrap("div", "fb2-verse");
    case "empty-line": return document.createElement("br");
    case "annotation": return wrap("div", "fb2-annotation");
    case "date": return wrap("time", "fb2-date");
    case "strikethrough": return wrap("s", "");
    case "sub": return wrap("sub", "");
    case "sup": return wrap("sup", "");
    case "code": return wrap("code", "");
    case "image": {
      const href = getXlinkHref(el);
      if (href && href.startsWith("#")) {
        const data = binaries[href.slice(1)];
        if (data) {
          const img = document.createElement("img");
          img.className = "fb2-image";
          img.src = data;
          img.alt = el.getAttribute("alt") || "";
          img.loading = "lazy";
          return img;
        }
      }
      return document.createComment("missing image");
    }
    case "a": {
      const a = document.createElement("a");
      const href = getXlinkHref(el);
      a.href = href;
      if (!href.startsWith("#")) {
        a.target = "_blank";
        a.rel = "noopener";
      }
      appendChildren(a, el, binaries, depth + 1);
      return a;
    }
    default:
      // Неизвестный элемент — просто разворачиваем содержимое
      return wrap("span", "");
  }
}

function appendChildren(target, source, binaries, depth) {
  for (const child of source.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      target.appendChild(document.createTextNode(child.textContent));
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      target.appendChild(renderElement(child, binaries, depth));
    }
  }
}

function renderBook({ title, author, cover, body, binaries }) {
  // Header (cover + title + author)
  contentEl.innerHTML = "";

  if (cover) {
    const coverWrap = document.createElement("div");
    coverWrap.className = "fb2-cover";
    const img = document.createElement("img");
    img.src = cover;
    img.alt = "";
    coverWrap.appendChild(img);
    contentEl.appendChild(coverWrap);
  }

  const titleBlock = document.createElement("div");
  titleBlock.className = "fb2-book-header";
  const h = document.createElement("h1");
  h.className = "fb2-book-title";
  h.textContent = title;
  titleBlock.appendChild(h);
  if (author) {
    const a = document.createElement("div");
    a.className = "fb2-book-author";
    a.textContent = author;
    titleBlock.appendChild(a);
  }
  contentEl.appendChild(titleBlock);

  // Body content
  if (body) appendChildren(contentEl, body, binaries, 0);

  // Topbar metadata
  bookTitle.textContent = title;
  bookAuthor.textContent = author;
}

// --- Chapters & navigation -------------------------------------
function indexChapters() {
  // Берём секции верхнего уровня. Если их нет — разбиваем по h1/h2.
  let nodes = Array.from(contentEl.querySelectorAll(":scope > .fb2-section"));
  if (nodes.length === 0) {
    nodes = Array.from(contentEl.querySelectorAll(":scope > h1, :scope > h2"));
  }
  chapters = nodes;
  pageCountEl.textContent = chapters.length || 1;
  pageNumEl.textContent = chapters.length ? 1 : 1;
}

function setupChapterObserver() {
  if (!chapters.length) return;
  const observer = new IntersectionObserver(
    (entries) => {
      if (isScrollingProgrammatically) return;
      // ищем секцию, чей верх ближе всего к верху экрана (но в видимой зоне)
      let bestIdx = currentChapter;
      let bestTop = Infinity;
      for (const e of entries) {
        if (e.isIntersecting) {
          const top = Math.abs(e.boundingClientRect.top);
          if (top < bestTop) {
            bestTop = top;
            bestIdx = chapters.indexOf(e.target);
          }
        }
      }
      if (bestIdx !== currentChapter && bestIdx >= 0) {
        currentChapter = bestIdx;
        pageNumEl.textContent = currentChapter + 1;
        updateNavButtons();
      }
    },
    { rootMargin: "-100px 0px -60% 0px", threshold: [0, 0.1, 0.5] }
  );
  chapters.forEach((s) => observer.observe(s));
}

function updateNavButtons() {
  prevBtn.disabled = currentChapter <= 0;
  nextBtn.disabled = currentChapter >= chapters.length - 1;
}

function goToChapter(idx) {
  if (idx < 0 || idx >= chapters.length) return;
  currentChapter = idx;
  pageNumEl.textContent = idx + 1;
  updateNavButtons();
  isScrollingProgrammatically = true;
  chapters[idx].scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => { isScrollingProgrammatically = false; }, 700);
}

prevBtn.addEventListener("click", () => goToChapter(currentChapter - 1));
nextBtn.addEventListener("click", () => goToChapter(currentChapter + 1));

// Keyboard
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.key === "ArrowLeft" || e.key === "PageUp") {
    goToChapter(currentChapter - 1);
  } else if (e.key === "ArrowRight" || e.key === "PageDown") {
    goToChapter(currentChapter + 1);
  } else if (e.key === "Home") {
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else if (e.key === "End") {
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }
});

// Swipe
let touchStartX = 0, touchStartY = 0;
document.addEventListener("touchstart", (e) => {
  const t = e.changedTouches[0];
  touchStartX = t.clientX;
  touchStartY = t.clientY;
}, { passive: true });

document.addEventListener("touchend", (e) => {
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStartX;
  const dy = t.clientY - touchStartY;
  if (Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    if (dx < 0) goToChapter(currentChapter + 1);
    else goToChapter(currentChapter - 1);
  }
}, { passive: true });

// --- Save scroll position --------------------------------------
let saveT;
window.addEventListener("scroll", () => {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    localStorage.setItem(BOOK.storageKey + ".scroll", String(window.scrollY));
  }, 300);
}, { passive: true });

function restoreScroll() {
  const y = parseInt(localStorage.getItem(BOOK.storageKey + ".scroll") || "0", 10);
  if (y > 0) {
    requestAnimationFrame(() => window.scrollTo(0, y));
  }
}

// ============================================================
// Bookmark feature — сохраняем точный range выделения
// ============================================================
const BOOKMARK_KEY = BOOK.storageKey + ".bookmark";
let jumpUsedThisSession = false;

// 1) data-bm на всех блоках (абзацах, заголовках) — якоря для закладки
function assignBookmarkIds() {
  const blocks = contentEl.querySelectorAll(
    "p, h1, h2, h3, h4, .fb2-title, .fb2-subtitle"
  );
  blocks.forEach((el, i) => el.setAttribute("data-bm", String(i)));
}

// Находим ближайший блок с data-bm вверх по дереву
function findBookmarkable(node) {
  let el = node && node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
  while (el && el !== contentEl && el !== document.body) {
    if (el.nodeType === Node.ELEMENT_NODE && el.hasAttribute && el.hasAttribute("data-bm")) {
      return el;
    }
    el = el.parentNode;
  }
  return null;
}

// 2) Утилиты: смещение в тексте блока ↔ (node, offset)
function getTextOffsetInBlock(block, node, nodeOffset) {
  if (!block || !node) return -1;
  if (node.nodeType === Node.TEXT_NODE) {
    let acc = 0;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n === node) return acc + nodeOffset;
      acc += n.textContent.length;
    }
    return -1;
  }
  // Элементный node — считаем длину текста до него через Range
  const r = document.createRange();
  r.selectNodeContents(block);
  r.setEnd(node, nodeOffset);
  return r.toString().length;
}

function locateInBlock(block, offset) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let n, lastNode = null;
  while ((n = walker.nextNode())) {
    lastNode = n;
    const len = n.textContent.length;
    if (acc + len >= offset) {
      return { node: n, offset: Math.max(0, offset - acc) };
    }
    acc += len;
  }
  if (lastNode) return { node: lastNode, offset: lastNode.textContent.length };
  return null;
}

// 3) Обернуть Range в span.bookmark-highlight (может быть несколько — по одному на каждый text-node)
function wrapRange(range) {
  const spans = [];
  const startContainer = range.startContainer;
  const endContainer = range.endContainer;
  const startOffset = range.startOffset;
  const endOffset = range.endOffset;

  // Собираем все text-node'ы, пересекающиеся с range
  const textNodes = [];
  const walker = document.createTreeWalker(
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode
      : range.commonAncestorContainer,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (n) => {
        if (!n.textContent.length) return NodeFilter.FILTER_REJECT;
        return range.intersectsNode(n)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    }
  );
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  // Edge-case: диапазон целиком внутри одного text-node
  if (textNodes.length === 0 && startContainer.nodeType === Node.TEXT_NODE) {
    textNodes.push(startContainer);
  }

  for (const node of textNodes) {
    const isStart = node === startContainer;
    const isEnd = node === endContainer;
    let target = node;

    if (isStart && isEnd) {
      if (endOffset < node.textContent.length) node.splitText(endOffset);
      target = startOffset > 0 ? node.splitText(startOffset) : node;
    } else if (isEnd) {
      if (endOffset < node.textContent.length) node.splitText(endOffset);
      target = node;
    } else if (isStart) {
      target = startOffset > 0 ? node.splitText(startOffset) : node;
    }

    if (!target || !target.textContent) continue;
    if (target.parentNode && target.parentNode.classList &&
        target.parentNode.classList.contains("bookmark-highlight")) continue;

    const span = document.createElement("span");
    span.className = "bookmark-highlight";
    target.parentNode.insertBefore(span, target);
    span.appendChild(target);
    spans.push(span);
  }

  return spans;
}

// 4) Снять все существующие подсветки (для замены на новую)
function unwrapHighlights() {
  const spans = Array.from(contentEl.querySelectorAll(".bookmark-highlight"));
  const parents = new Set();
  for (const span of spans) {
    const p = span.parentNode;
    if (!p) continue;
    parents.add(p);
    while (span.firstChild) p.insertBefore(span.firstChild, span);
    p.removeChild(span);
  }
  for (const p of parents) p.normalize(); // склеить соседние text-node'ы
}

// 5) Сохранение/восстановление по JSON
function saveBookmarkFromSelection(sel) {
  const range = sel.getRangeAt(0);
  const startBlock = findBookmarkable(range.startContainer);
  const endBlock = findBookmarkable(range.endContainer);
  if (!startBlock || !endBlock) return null;

  const startBm = startBlock.getAttribute("data-bm");
  const endBm = endBlock.getAttribute("data-bm");
  const startOffset = getTextOffsetInBlock(startBlock, range.startContainer, range.startOffset);
  const endOffset = getTextOffsetInBlock(endBlock, range.endContainer, range.endOffset);
  if (startOffset < 0 || endOffset < 0) return null;

  const bm = { startBm, startOffset, endBm, endOffset };
  localStorage.setItem(BOOKMARK_KEY, JSON.stringify(bm));
  return bm;
}

function applyBookmarkFromStorage() {
  unwrapHighlights();
  const raw = localStorage.getItem(BOOKMARK_KEY);
  if (!raw) return null;
  let bm;
  try { bm = JSON.parse(raw); } catch { return null; }
  if (!bm || bm.startBm == null || bm.endBm == null) return null;

  const startBlock = contentEl.querySelector(`[data-bm="${CSS.escape(bm.startBm)}"]`);
  const endBlock = contentEl.querySelector(`[data-bm="${CSS.escape(bm.endBm)}"]`);
  if (!startBlock || !endBlock) return null;

  const start = locateInBlock(startBlock, bm.startOffset);
  const end = locateInBlock(endBlock, bm.endOffset);
  if (!start || !end) return null;

  try {
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    if (range.collapsed) return null;
    const spans = wrapRange(range);
    return spans[0] || null;
  } catch (e) {
    console.warn("Не удалось применить закладку:", e);
    return null;
  }
}

// 6) Показ/скрытие пилюли "Остановиться здесь"
function showSelectionToolbar() {
  selectionToolbar.hidden = false;
  requestAnimationFrame(() => selectionToolbar.classList.add("visible"));
}

function hideSelectionToolbar() {
  selectionToolbar.classList.remove("visible");
  setTimeout(() => {
    if (!selectionToolbar.classList.contains("visible")) {
      selectionToolbar.hidden = true;
    }
  }, 280);
}

function handleSelectionChange() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    hideSelectionToolbar();
    return;
  }
  const range = sel.getRangeAt(0);
  if (!contentEl.contains(range.startContainer)) {
    hideSelectionToolbar();
    return;
  }
  const text = sel.toString().trim();
  if (text.length < 1) {
    hideSelectionToolbar();
    return;
  }
  showSelectionToolbar();
}

let selChangeT;
document.addEventListener("selectionchange", () => {
  clearTimeout(selChangeT);
  selChangeT = setTimeout(handleSelectionChange, 120);
});

// 7) На iOS preventDefault на pointerdown не даёт iOS снять выделение до click
bookmarkBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); });
bookmarkBtn.addEventListener("mousedown", (e) => { e.preventDefault(); });

// 8) Клик по "Остановиться здесь"
bookmarkBtn.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  if (!contentEl.contains(sel.anchorNode)) return;

  const bm = saveBookmarkFromSelection(sel);
  if (!bm) return;

  sel.removeAllRanges();
  hideSelectionToolbar();

  // Применяем новую подсветку (старая снимется внутри applyBookmarkFromStorage)
  const span = applyBookmarkFromStorage();

  showToast("Закладка сохранена");
  jumpUsedThisSession = true;
  hideJumpButton();

  if (span) pulseHighlight();
});

// 9) Тост
let toastT;
function showToast(text) {
  toastText.textContent = text;
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add("visible"));
  clearTimeout(toastT);
  toastT = setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => { toast.hidden = true; }, 320);
  }, 1600);
}

// 10) Кнопка-закладка в навбаре
function showJumpButton() {
  navDivider.hidden = false;
  jumpBtn.hidden = false;
}

function hideJumpButton() {
  jumpBtn.hidden = true;
  navDivider.hidden = true;
}

function setupJumpButton() {
  if (jumpUsedThisSession) { hideJumpButton(); return; }
  const span = contentEl.querySelector(".bookmark-highlight");
  if (!span) { hideJumpButton(); return; }
  showJumpButton();
}

// Пульс поверх подсветки (при сохранении / прыжке)
function pulseHighlight() {
  const spans = contentEl.querySelectorAll(".bookmark-highlight");
  spans.forEach((s) => s.classList.remove("bookmark-pulse"));
  // reflow
  if (spans[0]) void spans[0].offsetWidth;
  spans.forEach((s) => s.classList.add("bookmark-pulse"));
  setTimeout(() => {
    spans.forEach((s) => s.classList.remove("bookmark-pulse"));
  }, 1700);
}

jumpBtn.addEventListener("click", () => {
  const first = contentEl.querySelector(".bookmark-highlight");
  if (!first) return;
  isScrollingProgrammatically = true;
  first.scrollIntoView({ behavior: "smooth", block: "center" });
  setTimeout(() => {
    pulseHighlight();
    isScrollingProgrammatically = false;
  }, 600);
  jumpUsedThisSession = true;
  hideJumpButton();
});

// --- Load book -------------------------------------------------
async function loadBook() {
  try {
    const xmlText = await fetchBook();
    const book = parseFB2(xmlText);
    renderBook(book);
    assignBookmarkIds();
    applyBookmarkFromStorage();   // восстановить подсветку из localStorage
    indexChapters();
    setupChapterObserver();
    updateNavButtons();
    loadingEl.hidden = true;
    restoreScroll();
    setupJumpButton();
  } catch (err) {
    console.error("Не удалось загрузить книгу:", err);
    loadingEl.hidden = true;
    errorEl.hidden = false;
  }
}

loadBook();

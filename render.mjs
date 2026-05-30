import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { marked } from '../PDF_Translation/node_modules/marked/lib/marked.esm.js';

const baseDir = 'C:/Users/18086/Desktop/Translation/Claude_System_Cards';
const cards = JSON.parse(readFileSync(join(baseDir, 'cards.json'), 'utf-8'));

function esc(v) {
  return String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function renderCard(card) {
  const mdPath = join(baseDir, card.id, 'translated.md');
  if (!existsSync(mdPath)) return null;
  const md = readFileSync(mdPath, 'utf-8').replace(/\r\n/g, '\n');

  const modelMatch = md.match(/翻译模型：(.+)/);
  const model = modelMatch ? modelMatch[1].trim() : '未知';

  // images extracted from the source PDF, keyed by PDF page number.
  const mapPath = join(baseDir, card.id, 'images', 'map.json');
  const imageMap = existsSync(mapPath) ? JSON.parse(readFileSync(mapPath, 'utf-8')) : {};
  const placed = new Set();
  function imgHtml(n) {
    return imageMap[n].map((f) =>
      `<div class="page-image"><img src="${card.id}/images/${esc(f)}" alt="第 ${esc(n)} 页配图" loading="lazy"></div>`
    ).join('');
  }
  // place each page's images right after its "--- Page N ---" marker (as a raw
  // HTML block on its own paragraph) so they land in the correct section. clean()
  // later removes the marker text line but keeps these injected <div> blocks.
  function injectImages(s) {
    return s.replace(/^(\s*-{2,3}\s*Page\s+(\d+).*-{2,3}\s*)$/gim, (full, line, n) => {
      if (!imageMap[n] || !imageMap[n].length) return full;
      placed.add(n);
      return `${line}\n\n${imgHtml(n)}\n`;
    });
  }

  // strip PDF cruft: "--- Page N ---" markers, standalone footer page numbers,
  // and contiguous table-of-contents blocks ("§编号 标题 行尾页码"). Isolated
  // body headings that merely end in a number (e.g. "Vending-Bench 2") are kept.
  const tocRe = /^\s*-?\s*(\d+(\.\d+)*|执行摘要|附录[A-Z]?)\s.*\s\d{1,3}$/;
  function clean(s) {
    let lines = s.split('\n')
      .filter((ln) => !/^\s*-{2,3}\s*Page\s+\d+.*-{2,3}\s*$/i.test(ln))
      .filter((ln) => !/^\s*\d{1,4}\s*$/.test(ln));
    const hit = lines.map((ln) => tocRe.test(ln.trim()));
    lines = lines.filter((ln, i) => !(hit[i] && (hit[i - 1] || hit[i + 1])));
    return lines.join('\n').trim();
  }

  // cover page: PDF dumps title/subtitle/date/url as bare adjacent lines on Page 1,
  // which markdown soft-merges or glues onto the heading. Normalize only the Page-1
  // cover block: merge a lone heading with its following subtitle line, and put each
  // remaining cover line in its own block. Everything from Page 2 on is left intact.
  function coverFix(raw) {
    const lines = raw.split('\n');
    let cut = lines.findIndex((ln, i) => i > 0 && /^-{2,3}\s*Page/i.test(ln));
    if (cut < 0) cut = lines.length;
    const cover = [];
    for (let i = 0; i < cut; i++) {
      const ln = lines[i].trim();
      if (!ln || /^-{2,3}\s*Page/i.test(ln)) continue;
      if (/^#{1,6}\s/.test(ln) && cover.length === 0 && i + 1 < cut && lines[i + 1].trim() && !/^#{1,6}\s/.test(lines[i + 1].trim())) {
        cover.push(ln + ' ' + lines[++i].trim());
      } else {
        cover.push(ln);
      }
    }
    const rest = lines.slice(cut).join('\n');
    return cover.join('\n\n') + (rest ? '\n\n' + rest : '');
  }

  const rawSections = md.split(/\n\n---\n\n/).map((s) => s.trim()).filter(Boolean);
  const sections = rawSections.map((s) => clean(injectImages(s))).filter(Boolean);
  // section 0 is the generated file header; section 1 is the PDF cover page.
  if (sections.length > 1) sections[1] = coverFix(sections[1]);

  // fallback for pages whose "--- Page N ---" marker did not survive (e.g.
  // opus-4-8 reuses an older translation with no markers, or the model dropped a
  // marker). Map page -> content section by proportion and append the images.
  const allPages = Object.keys(imageMap).map(Number);
  const leftover = allPages.filter((n) => !placed.has(String(n)));
  if (leftover.length && sections.length > 1) {
    const maxPage = Math.max(...allPages);
    const first = 1; // skip file header (section 0)
    const last = sections.length - 1;
    const bySec = {};
    for (const n of leftover) {
      const idx = Math.min(last, Math.max(first, first + Math.round((n - 1) / maxPage * (last - first))));
      (bySec[idx] ||= []).push(n);
    }
    for (const [idx, pages] of Object.entries(bySec)) {
      sections[idx] += '\n\n' + pages.sort((a, b) => a - b).map((n) => imgHtml(String(n))).join('\n\n');
    }
  }

  let hc = 0;
  const renderer = new marked.Renderer();
  renderer.heading = function ({ tokens, depth }) {
    const text = this.parser.parseInline(tokens);
    return `<h${depth} id="${card.id}-h${hc++}">${text}</h${depth}>`;
  };
  marked.use({ renderer });

  const pagesHtml = sections.map((sec, i) =>
    `<div class="page" data-page="${i}">${marked.parse(sec)}<div class="page-number">第 ${i + 1} / ${sections.length} 页</div></div>`
  ).join('');

  const headings = [];
  const re = /<h([1-4])\s+id="([^"]+)">(.*?)<\/h[1-4]>/gi;
  let m;
  while ((m = re.exec(pagesHtml)) !== null) {
    headings.push({ level: +m[1], id: m[2], text: m[3].replace(/<[^>]*>/g, '') });
  }
  const toc = headings.map((h) =>
    `<div class="toc-item toc-level-${h.level}" style="padding-left:${(h.level - 1) * 16 + 12}px" data-id="${esc(h.id)}">${esc(h.text)}</div>`
  ).join('\n');

  return { ...card, model, pagesHtml, toc, sections: sections.length };
}

const rendered = cards.map(renderCard).filter(Boolean);
const dataJSON = JSON.stringify(rendered.map((c) => ({
  id: c.id, title: c.title, date: c.date, model: c.model,
  pages: c.pagesHtml, toc: c.toc, total: c.sections,
})));

const options = rendered.map((c, i) =>
  `<option value="${i}">${esc(c.title)}</option>`
).join('');

const html = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude 系列系统卡片 - 中文翻译</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700&display=swap');

* { margin: 0; padding: 0; box-sizing: border-box; }
PLACEHOLDER_STYLE
</style>
</head>
<body>

<button class="sidebar-toggle" id="sidebarToggle" title="收起/展开目录">&#9776;</button>

<div class="sidebar" id="sidebar">
  <div class="sidebar-header">
    <h2>Claude 系列系统卡片</h2>
    <select id="cardSelect">CARD_OPTIONS</select>
    <div class="meta">原文日期：<span id="mDate"></span> ｜ 翻译模型：<b id="mModel"></b></div>
    <div class="page-jump">
      <input type="number" id="pageInput" min="1" placeholder="页码">
      <button onclick="jumpToPage()">跳转</button>
      <span id="pageTotal"></span>
    </div>
    <div class="toolbar">
      <button id="themeToggle">夜间模式</button>
    </div>
  </div>
  <div class="toc-container" id="tocContainer"></div>
</div>

<div class="main" id="mainContent"></div>

<script>
PLACEHOLDER_SCRIPT
</script>
</body>
</html>`;

const STYLE = String.raw`
:root {
  --paper-bg: #f5f0e8;
  --paper-dark: #e8e0d0;
  --ink: #2c2416;
  --ink-light: #5c4a32;
  --accent: #8b4513;
  --sidebar-width: 300px;
  --main-bg: #d4c5a9;
  --main-surface: linear-gradient(135deg, #f7f2ea 0%, #f0e8d8 50%, #ede4d0 100%);
  --border-color: #b8a88a;
  --page-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.04);
}

[data-theme="dark"] {
  --paper-bg: #1e1e1e;
  --paper-dark: #2a2a2a;
  --ink: #e0d8c8;
  --ink-light: #b0a890;
  --accent: #d4a06a;
  --main-bg: #141414;
  --main-surface: linear-gradient(135deg, #1a1a1a 0%, #1e1e1e 50%, #222 100%);
  --border-color: #3a3a3a;
  --page-shadow: 0 1px 3px rgba(0,0,0,0.3), 0 8px 24px rgba(0,0,0,0.2);
}

body {
  font-family: "KaiTi", "楷体", "STKaiti", "Noto Serif SC", serif;
  background: var(--main-bg);
  color: var(--ink);
  line-height: 1.9;
  font-size: 16px;
  display: flex;
  height: 100vh;
  overflow: hidden;
}

.sidebar {
  width: var(--sidebar-width);
  height: 100vh;
  background: var(--paper-dark);
  border-right: 2px solid var(--border-color);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  box-shadow: 2px 0 8px rgba(0,0,0,0.1);
  transition: width 0.3s, transform 0.3s;
  position: relative;
}

.sidebar.collapsed {
  width: 0;
  overflow: hidden;
  border-right: none;
}

.sidebar-toggle {
  position: fixed;
  top: 12px;
  left: 12px;
  z-index: 1000;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--paper-dark);
  border: 1px solid var(--border-color);
  color: var(--accent);
  font-size: 18px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: left 0.3s, background 0.2s;
  box-shadow: 0 2px 6px rgba(0,0,0,0.1);
}

.sidebar-toggle:hover { background: var(--accent); color: #fff; }

body:not(.sidebar-hidden) .sidebar-toggle {
  left: calc(var(--sidebar-width) - 44px);
}

.toolbar {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.toolbar button {
  padding: 4px 10px;
  background: var(--paper-dark);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
  font-size: 12px;
  color: var(--ink-light);
  transition: all 0.15s;
}

.toolbar button:hover { background: var(--accent); color: #fff; border-color: var(--accent); }

.sidebar-header {
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--paper-bg);
}

.sidebar-header h2 {
  font-size: 15px;
  color: var(--accent);
  margin-bottom: 8px;
}

#cardSelect {
  width: 100%;
  padding: 6px 8px;
  margin-bottom: 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--paper-bg);
  color: var(--ink);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
}

.meta {
  font-size: 12px;
  color: var(--ink-light);
  margin-bottom: 8px;
}

.meta b { color: var(--accent); font-weight: 600; }

.page-jump {
  display: flex;
  gap: 6px;
  align-items: center;
}

.page-jump input {
  width: 60px;
  padding: 4px 8px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--paper-bg);
  color: var(--ink);
  font-family: inherit;
  font-size: 13px;
}

.page-jump button {
  padding: 4px 12px;
  background: var(--accent);
  color: #fff;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
  font-size: 13px;
}

.page-jump button:hover { background: #6b3410; }

.page-jump span {
  font-size: 12px;
  color: var(--ink-light);
}

.toc-container {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.toc-item {
  padding: 4px 12px;
  cursor: pointer;
  font-size: 13px;
  color: var(--ink-light);
  border-left: 3px solid transparent;
  transition: all 0.15s;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toc-item:hover {
  background: rgba(139, 69, 19, 0.08);
  color: var(--accent);
}

.toc-item.active {
  border-left-color: var(--accent);
  color: var(--accent);
  background: rgba(139, 69, 19, 0.05);
  font-weight: 600;
}

.toc-level-1 { font-size: 14px; font-weight: 700; }
.toc-level-2 { font-size: 13px; font-weight: 600; }
.toc-level-3 { font-size: 12.5px; }
.toc-level-4 { font-size: 12px; }

.main {
  flex: 1;
  overflow-y: auto;
  padding: 40px 60px;
  background:
    repeating-linear-gradient(
      0deg,
      transparent,
      transparent 38px,
      rgba(139, 69, 19, 0.03) 38px,
      rgba(139, 69, 19, 0.03) 39px
    ),
    var(--main-surface);
  background-attachment: local;
}

[data-theme="dark"] .main {
  background:
    repeating-linear-gradient(
      0deg,
      transparent,
      transparent 38px,
      rgba(255, 255, 255, 0.02) 38px,
      rgba(255, 255, 255, 0.02) 39px
    ),
    var(--main-surface);
}

.page {
  max-width: 860px;
  margin: 0 auto 60px;
  padding: 48px 56px;
  background: var(--paper-bg);
  border: 1px solid var(--border-color);
  border-radius: 2px;
  box-shadow: var(--page-shadow);
  position: relative;
}

.page::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0; bottom: 0;
  background:
    radial-gradient(ellipse at 20% 50%, rgba(139, 69, 19, 0.015) 0%, transparent 70%),
    radial-gradient(ellipse at 80% 20%, rgba(101, 67, 33, 0.01) 0%, transparent 60%);
  pointer-events: none;
}

.page-number {
  position: absolute;
  bottom: 16px;
  right: 24px;
  font-size: 12px;
  color: var(--ink-light);
  opacity: 0.6;
}

.page h1 {
  font-size: 26px;
  color: var(--accent);
  margin: 24px 0 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(139, 69, 19, 0.2);
}

.page h2 {
  font-size: 21px;
  color: var(--accent);
  margin: 20px 0 12px;
}

.page h3 {
  font-size: 18px;
  color: var(--ink);
  margin: 16px 0 10px;
}

.page h4 {
  font-size: 16px;
  color: var(--ink-light);
  margin: 12px 0 8px;
}

.page p {
  margin: 10px 0;
  text-align: justify;
  text-indent: 2em;
}

.page ul, .page ol {
  margin: 10px 0 10px 2em;
}

.page li {
  margin: 4px 0;
}

.page li p {
  text-indent: 0;
  margin: 4px 0;
}

.page table {
  width: 100%;
  border-collapse: collapse;
  margin: 16px 0;
  font-size: 14px;
}

.page th, .page td {
  border: 1px solid var(--border-color);
  padding: 8px 10px;
  text-align: left;
}

.page th {
  background: var(--paper-dark);
  font-weight: 600;
}

.page tr:nth-child(even) {
  background: rgba(139, 69, 19, 0.02);
}

.page code {
  background: rgba(139, 69, 19, 0.06);
  padding: 2px 5px;
  border-radius: 3px;
  font-size: 14px;
  font-family: "Consolas", monospace;
}

.page pre {
  background: #2c2416;
  color: #f0e8d8;
  padding: 16px;
  border-radius: 4px;
  overflow-x: auto;
  margin: 12px 0;
}

[data-theme="dark"] .page pre {
  background: #111;
  color: #d4c5a9;
}

.page pre code {
  background: none;
  padding: 0;
  color: inherit;
}

.page blockquote {
  border-left: 3px solid var(--accent);
  padding: 8px 16px;
  margin: 12px 0;
  background: rgba(139, 69, 19, 0.03);
  color: var(--ink-light);
}

.page strong { color: var(--accent); }

.page-image {
  margin: 16px 0;
  text-align: center;
}

.page-image img {
  max-width: 100%;
  height: auto;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
}

.page a { font-size: 0.82em; word-break: break-all; overflow-wrap: anywhere; }

::-webkit-scrollbar { width: 8px; }
::-webkit-scrollbar-track { background: var(--paper-dark); }
::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--accent); }

@media (max-width: 900px) {
  .sidebar { width: 240px; }
  .main { padding: 20px; }
  .page { padding: 24px; }
  body:not(.sidebar-hidden) .sidebar-toggle { left: 196px; }
}`;

const SCRIPT = String.raw`
const DATA = ${dataJSON};

const mainEl = document.getElementById('mainContent');
const tocContainer = document.getElementById('tocContainer');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebarToggle');
const themeToggle = document.getElementById('themeToggle');
const cardSelect = document.getElementById('cardSelect');
let tocItems = [];
let totalPages = 0;

function load(i) {
  const c = DATA[i];
  document.getElementById('mDate').textContent = c.date;
  document.getElementById('mModel').textContent = c.model;
  mainEl.innerHTML = c.pages;
  tocContainer.innerHTML = c.toc;
  totalPages = c.total;
  document.getElementById('pageTotal').textContent = '/ ' + totalPages;
  bindToc();
  mainEl.scrollTop = 0;
  setTimeout(updateActiveToc, 100);
}

function bindToc() {
  tocItems = [...tocContainer.querySelectorAll('.toc-item')];
  tocItems.forEach(item => {
    item.addEventListener('click', () => {
      const target = mainEl.querySelector('#' + CSS.escape(item.dataset.id));
      if (target) {
        const offset = target.getBoundingClientRect().top - mainEl.getBoundingClientRect().top + mainEl.scrollTop;
        mainEl.scrollTo({ top: offset - 20, behavior: 'smooth' });
      }
    });
  });
}

cardSelect.addEventListener('change', () => load(+cardSelect.value));

sidebarToggle.addEventListener('click', () => {
  sidebar.classList.toggle('collapsed');
  document.body.classList.toggle('sidebar-hidden');
});

function setTheme(dark) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  themeToggle.textContent = dark ? '日间模式' : '夜间模式';
  localStorage.setItem('theme', dark ? 'dark' : 'light');
}

themeToggle.addEventListener('click', () => {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  setTheme(!isDark);
});

if (localStorage.getItem('theme') === 'dark') setTheme(true);

function jumpToPage() {
  const num = parseInt(document.getElementById('pageInput').value);
  if (num >= 1 && num <= totalPages) {
    const target = mainEl.querySelector('.page[data-page="' + (num - 1) + '"]');
    if (target) mainEl.scrollTo({ top: target.offsetTop - mainEl.offsetTop, behavior: 'smooth' });
  }
}

document.getElementById('pageInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') jumpToPage();
});

let ticking = false;
mainEl.addEventListener('scroll', () => {
  if (!ticking) {
    requestAnimationFrame(() => { updateActiveToc(); ticking = false; });
    ticking = true;
  }
}, { passive: true });

function updateActiveToc() {
  const rect = mainEl.getBoundingClientRect();
  const viewMid = rect.top + rect.height * 0.3;
  let activeId = null;
  const allHeadings = mainEl.querySelectorAll('h1[id], h2[id], h3[id], h4[id]');
  for (let i = allHeadings.length - 1; i >= 0; i--) {
    if (allHeadings[i].getBoundingClientRect().top <= viewMid) { activeId = allHeadings[i].id; break; }
  }
  tocItems.forEach(item => {
    if (item.dataset.id === activeId) {
      item.classList.add('active');
      const itemRect = item.getBoundingClientRect();
      const containerRect = tocContainer.getBoundingClientRect();
      if (itemRect.top < containerRect.top || itemRect.bottom > containerRect.bottom) {
        item.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    } else {
      item.classList.remove('active');
    }
  });
}

load(0);`;

const finalHtml = html
  .replace('PLACEHOLDER_STYLE', STYLE)
  .replace('CARD_OPTIONS', options)
  .replace('PLACEHOLDER_SCRIPT', SCRIPT);

writeFileSync(join(baseDir, 'index.html'), finalHtml, 'utf-8');
console.log('Shared reader written. Cards included:', rendered.length);
for (const c of rendered) console.log(`  ${c.id} (${c.model}): ${c.sections} sections`);

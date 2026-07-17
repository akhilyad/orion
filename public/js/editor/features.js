/**
 * Orion editor — feature engines behind the menu bar:
 * text search, find & replace (cover + retype), print, stamps,
 * bookmarks/attachments readers, preferences.
 *
 * Geometry note: pdf.js getTextContent() returns each item's transform in
 * PDF user space — [a, b, c, d, e, f] where (e, f) is the baseline start,
 * atan2(b, a) the text angle and hypot(c, d) ≈ the font height. All rects
 * we derive stay in user space and are converted per-frame for display.
 */
'use strict';

import { S, bus } from './state.js';
import { toViewportPoint, toPdfPoint } from './viewer.js';
import * as ops from './docops.js';

/* ═══════════════════ Text items ═══════════════════ */

/** Normalized text runs for a page (1-based). */
export async function textItems(pageNo) {
  const page = await S.pdf.getPage(pageNo);
  const content = await page.getTextContent();
  return content.items
    .filter((it) => it.str && it.str.trim().length)
    .map((it) => {
      const t = it.transform;
      return {
        str: it.str,
        x: t[4],
        y: t[5],
        width: it.width,
        size: Math.hypot(t[2], t[3]) || it.height || 12,
        angleRad: Math.atan2(t[1], t[0]),
      };
    });
}

/* ═══════════════════ Search ═══════════════════ */

export const search = {
  query: '',
  matches: [],  // { page, item, start, len, rect: {corners: [[x,y]×4]} }
  current: -1,
};

function matchRect(item, start, len) {
  const charW = item.width / item.str.length;
  const off = charW * start;
  const w = charW * len;
  const h = item.size;
  const u = { x: Math.cos(item.angleRad), y: Math.sin(item.angleRad) };
  const v = { x: -u.y, y: u.x };
  const p0 = { x: item.x + off * u.x - 0.25 * h * v.x, y: item.y + off * u.y - 0.25 * h * v.y };
  return {
    corners: [
      [p0.x, p0.y],
      [p0.x + w * u.x, p0.y + w * u.y],
      [p0.x + w * u.x + 1.2 * h * v.x, p0.y + w * u.y + 1.2 * h * v.y],
      [p0.x + 1.2 * h * v.x, p0.y + 1.2 * h * v.y],
    ],
  };
}

/** Scan the whole document for `query` (case-insensitive, per text run). */
export async function runSearch(query) {
  search.query = query;
  search.matches = [];
  search.current = -1;
  if (!S.pdf || !query) return search;

  const q = query.toLowerCase();
  for (let p = 1; p <= S.pageCount; p++) {
    const items = await textItems(p);
    for (const item of items) {
      const hay = item.str.toLowerCase();
      let idx = hay.indexOf(q);
      while (idx !== -1) {
        search.matches.push({
          page: p, item, start: idx, len: query.length,
          rect: matchRect(item, idx, query.length),
        });
        idx = hay.indexOf(q, idx + Math.max(1, query.length));
      }
    }
  }
  if (search.matches.length) search.current = 0;
  return search;
}

export function stepSearch(dir) {
  if (!search.matches.length) return null;
  search.current = (search.current + dir + search.matches.length) % search.matches.length;
  return search.matches[search.current];
}

export function clearSearch() {
  search.query = '';
  search.matches = [];
  search.current = -1;
}

/** Overlay painter: outlines this page's matches, fills the current one. */
export function paintSearchHighlights(ctx) {
  if (!search.matches.length) return;
  const onPage = search.matches.filter((m) => m.page === S.page);
  if (!onPage.length) return;
  ctx.save();
  onPage.forEach((m) => {
    const pts = m.rect.corners.map(([x, y]) => toViewportPoint(x, y));
    const isCurrent = search.matches[search.current] === m;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fillStyle = isCurrent ? 'rgba(240, 179, 78, 0.5)' : 'rgba(37, 99, 235, 0.22)';
    ctx.fill();
  });
  ctx.restore();
}

/* ═══════════════════ Find & Replace ═══════════════════ */

/**
 * Replace one search match by covering from the match start to the end of
 * its text run and retyping (replacement + the run's tail). Reloads the
 * document, so previous match geometry becomes stale — re-search after.
 */
export async function replaceMatch(match, replacement) {
  const { item, start, len, page } = match;
  const charW = item.width / item.str.length;
  const off = charW * start;
  const u = { x: Math.cos(item.angleRad), y: Math.sin(item.angleRad) };
  const tail = item.str.slice(start + len);
  const newText = replacement + tail;

  await ops.coverAndRetype(page - 1, {
    x: item.x + off * u.x,
    y: item.y + off * u.y,
    width: item.width - off,
    size: item.size,
    angleRad: item.angleRad,
  }, { text: newText, size: item.size, colorHex: '#111111' });
}

/** Replace every occurrence, re-searching between passes. Returns count. */
export async function replaceAll(query, replacement, onProgress) {
  let count = 0;
  const cap = 300; // runaway guard
  // Skip occurrences where replacement re-contains the query (would loop).
  const reentrant = replacement.toLowerCase().includes(query.toLowerCase());
  while (count < cap) {
    await runSearch(query);
    const next = search.matches[reentrant ? count : 0];
    if (!next) break;
    await replaceMatch(next, replacement);
    count += 1;
    if (onProgress) onProgress(count);
  }
  await runSearch(query);
  return count;
}

/* ═══════════════ Text lines (grouped runs) & live selection ═══════════════ */

/**
 * A "line" merges the page's text runs that share a baseline into one
 * editable block: { page, x, y (baseline start), width, size, angleRad,
 * str, cum } — `cum` maps every character boundary of `str` to its
 * along-baseline offset in user units, so clicks and drags resolve to
 * character positions. Big horizontal gaps (table cells, columns) split
 * a baseline into separate blocks, matching how the boxes should look.
 */
const linesCache = new Map();    // pageNo -> line[]
const linesPromises = new Map(); // pageNo -> Promise<line[]>

bus.on('doc', () => {
  linesCache.clear();
  linesPromises.clear();
  clearTextSel();
});

export function ensureLines(pageNo) {
  if (!linesPromises.has(pageNo)) {
    const p = (async () => {
      const items = await textItems(pageNo);
      const lines = buildLines(items, pageNo);
      linesCache.set(pageNo, lines);
      return lines;
    })().catch((err) => {
      linesPromises.delete(pageNo);
      throw err;
    });
    linesPromises.set(pageNo, p);
  }
  return linesPromises.get(pageNo);
}

/** Synchronously return cached lines for a page, or null if not built yet. */
export function linesFor(pageNo) {
  return linesCache.get(pageNo) || null;
}

function buildLines(items, pageNo) {
  // 1. bucket runs by (angle, baseline offset along the "up" axis)
  const groups = [];
  for (const it of items) {
    const u = { x: Math.cos(it.angleRad), y: Math.sin(it.angleRad) };
    const base = -it.x * u.y + it.y * u.x;      // distance along v = (-u.y, u.x)
    const along = it.x * u.x + it.y * u.y;      // distance along the baseline
    let g = groups.find((G) => Math.abs(G.angleRad - it.angleRad) < 0.02
      && Math.abs(G.base - base) < Math.max(2, 0.35 * Math.min(G.size, it.size)));
    if (!g) {
      g = { angleRad: it.angleRad, base, size: it.size, items: [] };
      groups.push(g);
    }
    g.size = Math.max(g.size, it.size);
    g.items.push({ ...it, along });
  }

  // 2. split each baseline on large gaps, materialize line records
  const out = [];
  for (const g of groups) {
    g.items.sort((a, b) => a.along - b.along);
    let seg = null;
    const flush = () => { if (seg) { out.push(materializeLine(seg, g, pageNo)); seg = null; } };
    for (const it of g.items) {
      if (seg && it.along - seg.end > Math.max(8, 1.6 * g.size)) flush();
      if (!seg) seg = { start: it.along, end: it.along + it.width, parts: [] };
      seg.parts.push(it);
      seg.end = Math.max(seg.end, it.along + it.width);
    }
    flush();
  }

  // 3. reading order: top line first, then left to right (in user space,
  //    so it survives page rotation)
  for (const ln of out) {
    const u = { x: Math.cos(ln.angleRad), y: Math.sin(ln.angleRad) };
    ln._v = -ln.x * u.y + ln.y * u.x;
    ln._a = ln.x * u.x + ln.y * u.y;
  }
  out.sort((A, B) => (B._v - A._v) || (A._a - B._a));
  out.forEach((ln, i) => { ln.idx = i; });
  return out;
}

function materializeLine(seg, g, pageNo) {
  let str = '';
  const cum = [0];
  let size = 0;
  for (const it of seg.parts) {
    const startOff = it.along - seg.start;
    if (str && startOff > cum[cum.length - 1] + 0.18 * g.size) {
      str += ' ';                          // bridge run gaps with one space
      cum.push(startOff);
    }
    const chW = it.width / it.str.length;
    for (let i = 0; i < it.str.length; i++) {
      str += it.str[i];
      cum.push(startOff + chW * (i + 1));
    }
    size = Math.max(size, it.size);
  }
  const first = seg.parts[0];
  return {
    page: pageNo, x: first.x, y: first.y,
    width: seg.end - seg.start, size: size || g.size,
    angleRad: g.angleRad, str, cum,
  };
}

/** Line + character index at/near a user-space point (needs cached lines). */
export function lineAt(pageNo, p, maxDist = 14) {
  const lines = linesCache.get(pageNo);
  if (!lines || !lines.length) return null;
  let best = null;
  let bestDist = Infinity;
  for (const ln of lines) {
    const u = { x: Math.cos(ln.angleRad), y: Math.sin(ln.angleRad) };
    const rel = { x: p.x - ln.x, y: p.y - ln.y };
    const along = rel.x * u.x + rel.y * u.y;
    const above = -rel.x * u.y + rel.y * u.x;
    const dx = Math.max(0, -along, along - ln.width);
    const dy = Math.max(0, -0.35 * ln.size - above, above - 1.15 * ln.size);
    const dist = Math.hypot(dx, dy);
    if (dist < bestDist) { bestDist = dist; best = { line: ln, along }; }
  }
  if (!best || bestDist > maxDist) return null;
  return { line: best.line, char: charAtAlong(best.line, best.along) };
}

function charAtAlong(line, along) {
  const cum = line.cum;
  if (along <= 0) return 0;
  for (let i = 1; i < cum.length; i++) {
    if (along < cum[i]) {
      return along - cum[i - 1] < cum[i] - along ? i - 1 : i;
    }
  }
  return line.str.length;
}

/* ── Live text selection (Select Text tool) ── */

export const textSel = { page: 0, anchor: null, focus: null }; // {idx, char}

export function beginTextSel(vx, vy) {
  const hit = lineAt(S.page, toPdfPoint(vx, vy), 4);
  if (!hit) { clearTextSel(); return false; }
  textSel.page = S.page;
  textSel.anchor = { idx: hit.line.idx, char: hit.char };
  textSel.focus = { idx: hit.line.idx, char: hit.char };
  return true;
}

export function extendTextSel(vx, vy) {
  if (!textSel.anchor || textSel.page !== S.page) return;
  const hit = lineAt(S.page, toPdfPoint(vx, vy), 40);
  if (hit) textSel.focus = { idx: hit.line.idx, char: hit.char };
}

export function clearTextSel() {
  textSel.page = 0;
  textSel.anchor = null;
  textSel.focus = null;
}

export function hasTextSel() {
  return !!(textSel.anchor && textSel.focus
    && (textSel.anchor.idx !== textSel.focus.idx
      || textSel.anchor.char !== textSel.focus.char));
}

/** Select every text line on the current page. Returns character count. */
export function selectAllText() {
  const lines = linesCache.get(S.page);
  if (!lines || !lines.length) return 0;
  const last = lines[lines.length - 1];
  textSel.page = S.page;
  textSel.anchor = { idx: 0, char: 0 };
  textSel.focus = { idx: last.idx, char: last.str.length };
  return selectedText().length;
}

function selRange() {
  let a = textSel.anchor;
  let b = textSel.focus;
  if (a.idx > b.idx || (a.idx === b.idx && a.char > b.char)) { const t = a; a = b; b = t; }
  return { a, b };
}

export function selectedText() {
  if (!hasTextSel()) return '';
  const lines = linesCache.get(textSel.page) || [];
  const { a, b } = selRange();
  const parts = [];
  for (let i = a.idx; i <= b.idx && i < lines.length; i++) {
    const ln = lines[i];
    const s = i === a.idx ? a.char : 0;
    const e = i === b.idx ? b.char : ln.str.length;
    parts.push(ln.str.slice(s, e));
  }
  return parts.join('\n');
}

/* ── Overlay painters ── */

/** User-space quad for a sub-range of a line (offsets in user units). */
function lineQuad(ln, off0, off1) {
  const u = { x: Math.cos(ln.angleRad), y: Math.sin(ln.angleRad) };
  const v = { x: -u.y, y: u.x };
  const h = ln.size;
  const w = off1 - off0;
  const p0 = { x: ln.x + off0 * u.x - 0.25 * h * v.x, y: ln.y + off0 * u.y - 0.25 * h * v.y };
  return [
    [p0.x, p0.y],
    [p0.x + w * u.x, p0.y + w * u.y],
    [p0.x + w * u.x + 1.2 * h * v.x, p0.y + w * u.y + 1.2 * h * v.y],
    [p0.x + 1.2 * h * v.x, p0.y + 1.2 * h * v.y],
  ];
}

function quadPath(ctx, corners) {
  const pts = corners.map(([x, y]) => toViewportPoint(x, y));
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

/** 1px dotted boxes around detected text blocks (Select/Edit Text tools). */
export function paintTextBlocks(ctx) {
  if (S.tool !== 'selecttext' && S.tool !== 'edittext') return;
  const lines = linesCache.get(S.page);
  if (!lines) {
    // build in the background, then ask the UI for a repaint
    ensureLines(S.page).then(() => bus.emit('text-lines-ready')).catch(() => {});
    return;
  }
  ctx.save();
  ctx.strokeStyle = 'rgba(23, 28, 43, 0.45)';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  for (const ln of lines) {
    quadPath(ctx, lineQuad(ln, -2, ln.width + 2));
    ctx.stroke();
  }
  ctx.restore();
}

/** Blue fill behind the currently selected text range. */
export function paintTextSel(ctx) {
  if (!hasTextSel() || textSel.page !== S.page) return;
  const lines = linesCache.get(textSel.page) || [];
  const { a, b } = selRange();
  ctx.save();
  ctx.fillStyle = 'rgba(37, 99, 235, 0.28)';
  for (let i = a.idx; i <= b.idx && i < lines.length; i++) {
    const ln = lines[i];
    const s = i === a.idx ? a.char : 0;
    const e = i === b.idx ? b.char : ln.str.length;
    if (e <= s) continue;
    quadPath(ctx, lineQuad(ln, ln.cum[s], ln.cum[e]));
    ctx.fill();
  }
  ctx.restore();
}

/* ═══════════════════ Print ═══════════════════ */

let printFrame = null;

/** Burn annotations, then hand the PDF to the browser's print dialog. */
export async function printPdf({ badge }) {
  const bytes = await ops.buildBurnedBytes({ badge });
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);

  if (printFrame) printFrame.remove();
  printFrame = document.createElement('iframe');
  printFrame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;visibility:hidden;';
  printFrame.src = url;
  document.body.appendChild(printFrame);

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Print preview timed out')), 15000);
    printFrame.onload = () => { clearTimeout(t); resolve(); };
  });
  printFrame.contentWindow.focus();
  printFrame.contentWindow.print();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ═══════════════════ Stamps ═══════════════════ */

export const STAMP_COLORS = {
  'APPROVED': '#1f9d55',
  'REJECTED': '#d43d2f',
  'DRAFT': '#2563eb',
  'CONFIDENTIAL': '#d43d2f',
  'REVIEWED': '#2563eb',
  'SIGN HERE': '#1f9d55',
};

/** Render a rubber-stamp PNG for the image-placement pipeline. */
export function buildStamp(label, colorHex) {
  const color = colorHex || STAMP_COLORS[label] || '#d43d2f';
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  const font = '700 44px "Fragment Mono", "Consolas", monospace';
  g.font = font;
  const tw = g.measureText(label).width;
  const padX = 30, padY = 20, border = 5;
  c.width = Math.ceil(tw + padX * 2 + border * 2);
  c.height = 44 + padY * 2 + border * 2;

  const g2 = c.getContext('2d');
  g2.strokeStyle = color;
  g2.lineWidth = border;
  const r = 14;
  const x = border / 2 + 1, y = border / 2 + 1;
  const w = c.width - border - 2, h = c.height - border - 2;
  g2.beginPath();
  g2.moveTo(x + r, y);
  g2.arcTo(x + w, y, x + w, y + h, r);
  g2.arcTo(x + w, y + h, x, y + h, r);
  g2.arcTo(x, y + h, x, y, r);
  g2.arcTo(x, y, x + w, y, r);
  g2.closePath();
  g2.stroke();

  g2.font = font;
  g2.fillStyle = color;
  g2.textAlign = 'center';
  g2.textBaseline = 'middle';
  g2.fillText(label, c.width / 2, c.height / 2 + 2);

  return { dataUrl: c.toDataURL('image/png'), fmt: 'png', w: c.width, h: c.height, kind: 'image' };
}

/* ═══════════════════ Bookmarks & attachments ═══════════════════ */

/** Flattened outline: [{ title, level, page }] (page may be null). */
export async function readBookmarks() {
  let outline = null;
  try {
    outline = await S.pdf.getOutline();
  } catch (e) { /* no outline */ }
  if (!outline || !outline.length) return [];

  const out = [];
  async function resolvePage(dest) {
    try {
      const d = typeof dest === 'string' ? await S.pdf.getDestination(dest) : dest;
      if (Array.isArray(d) && d[0]) {
        const idx = await S.pdf.getPageIndex(d[0]);
        return idx + 1;
      }
    } catch (e) { /* unresolvable destination */ }
    return null;
  }
  async function walk(items, level) {
    for (const it of items) {
      out.push({ title: it.title || '(untitled)', level, page: await resolvePage(it.dest) });
      if (it.items && it.items.length && level < 3) await walk(it.items, level + 1);
    }
  }
  await walk(outline, 1);
  return out;
}

/** Embedded file attachments: [{ name, bytes }]. */
export async function readAttachments() {
  let att = null;
  try {
    att = await S.pdf.getAttachments();
  } catch (e) { /* none */ }
  if (!att) return [];
  return Object.keys(att).map((key) => ({
    name: att[key].filename || key,
    bytes: att[key].content,
  }));
}

/* ═══════════════════ Preferences ═══════════════════ */

const PREFS_KEY = 'orion.prefs.v1';

export function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch (e) {
    return {};
  }
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (e) { /* private mode */ }
}

/** Apply stored preferences onto live state. */
export function applyPrefs() {
  const p = loadPrefs();
  if (p.color) S.color = p.color;
  if (p.fontSize) S.fontSize = p.fontSize;
  if (p.fontFamily) S.fontFamily = p.fontFamily;
  return p;
}

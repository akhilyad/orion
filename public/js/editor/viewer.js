/**
 * Orion editor — pdf.js rendering: main page canvas, thumbnails, zoom,
 * viewport coordinate conversion (viewport px ⇄ PDF user space).
 */
'use strict';

import { S, bus, newPageId } from './state.js';

const pdfjsLib = window.pdfjsLib;
pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

let lastViewport = null;
let lastBase = null; // { w, h } of the current page at scale 1 (pt)
let renderToken = 0;
let renderTask = null;

const els = {
  stage: () => document.getElementById('stage'),
  canvas: () => document.getElementById('page-canvas'),
  overlay: () => document.getElementById('overlay-canvas'),
  wrap: () => document.getElementById('page-wrap'),
  thumbs: () => document.getElementById('thumbs'),
};

/* ── Loading ────────────────────────────────────────────────────── */

/** Load a brand-new document (fresh page ids, annotations cleared by caller). */
export async function loadNewDocument(bytes, fileName) {
  const pdf = await openPdfJs(bytes);
  S.bytes = bytes;
  S.fileName = fileName || 'document.pdf';
  S.pdf = pdf;
  S.pageCount = pdf.numPages;
  S.page = 1;
  S.pageIds = [];
  for (let i = 0; i < pdf.numPages; i++) S.pageIds.push(newPageId());
  S.annots = {};
  S.mergeCount = 0;
  bus.emit('doc');
  await refresh();
}

/**
 * Swap in new bytes after a structural operation. The caller has already
 * updated S.pageIds / S.annots to match the new page arrangement.
 */
export async function reloadFromBytes(bytes) {
  const pdf = await openPdfJs(bytes);
  S.bytes = bytes;
  S.pdf = pdf;
  S.pageCount = pdf.numPages;
  if (S.page > S.pageCount) S.page = S.pageCount;
  if (S.page < 1) S.page = 1;
  bus.emit('doc');
  await refresh();
}

async function openPdfJs(bytes) {
  // pdf.js transfers the buffer to its worker — always hand it a copy.
  const task = pdfjsLib.getDocument({ data: bytes.slice() });
  return task.promise;
}

export async function refresh() {
  await renderPage();
  await renderThumbs();
}

/* ── Main page rendering ────────────────────────────────────────── */

export async function renderPage() {
  if (!S.pdf) return;
  const my = ++renderToken;

  if (renderTask) {
    try { renderTask.cancel(); } catch (e) { /* ignore */ }
    renderTask = null;
  }

  const page = await S.pdf.getPage(S.page);
  if (my !== renderToken) return;

  const base = page.getViewport({ scale: 1 });
  lastBase = { w: base.width, h: base.height };
  let scale;
  if (S.zoomMode === 'fit') {
    const stage = els.stage();
    const avail = Math.max(280, stage.clientWidth - 48);
    const availH = Math.max(280, stage.clientHeight - 48);
    scale = Math.min(avail / base.width, availH / base.height, 3);
    S.zoomScale = scale;
  } else if (S.zoomMode === 'fitw') {
    const stage = els.stage();
    const avail = Math.max(280, stage.clientWidth - 56);
    scale = Math.min(avail / base.width, 4);
    S.zoomScale = scale;
  } else {
    scale = S.zoomScale;
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const vp = page.getViewport({ scale });          // CSS-pixel viewport
  const vpx = page.getViewport({ scale: scale * dpr }); // device-pixel viewport

  const canvas = els.canvas();
  const overlay = els.overlay();
  const wrap = els.wrap();

  canvas.width = Math.floor(vpx.width);
  canvas.height = Math.floor(vpx.height);
  canvas.style.width = vp.width + 'px';
  canvas.style.height = vp.height + 'px';
  overlay.width = Math.floor(vp.width * dpr);
  overlay.height = Math.floor(vp.height * dpr);
  overlay.style.width = vp.width + 'px';
  overlay.style.height = vp.height + 'px';
  wrap.style.width = vp.width + 'px';
  wrap.style.height = vp.height + 'px';

  lastViewport = vp;

  try {
    renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport: vpx });
    await renderTask.promise;
  } catch (err) {
    if (err && err.name === 'RenderingCancelledException') return;
    throw err;
  } finally {
    renderTask = null;
  }

  if (my !== renderToken) return;
  bus.emit('rendered', vp);
}

/* ── Thumbnails ─────────────────────────────────────────────────── */

let thumbsToken = 0;

export async function renderThumbs() {
  if (!S.pdf) return;
  const my = ++thumbsToken;
  const host = els.thumbs();
  host.innerHTML = '';

  const frag = document.createDocumentFragment();
  const items = [];
  for (let i = 1; i <= S.pageCount; i++) {
    const item = document.createElement('div');
    item.className = 'thumb' + (i === S.page ? ' is-active' : '');
    item.draggable = true;
    item.dataset.page = String(i);
    item.innerHTML =
      '<canvas class="thumb-canvas"></canvas>' +
      '<span class="thumb-num">' + i + '</span>';
    frag.appendChild(item);
    items.push(item);
  }
  host.appendChild(frag);
  bus.emit('thumbs-built', host);

  // Render sequentially so we can abort cleanly on doc change.
  for (let i = 1; i <= S.pageCount; i++) {
    if (my !== thumbsToken) return;
    try {
      const page = await S.pdf.getPage(i);
      if (my !== thumbsToken) return;
      const base = page.getViewport({ scale: 1 });
      const scale = 108 / base.width;
      const vp = page.getViewport({ scale });
      const c = items[i - 1].querySelector('canvas');
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    } catch (e) {
      /* individual thumb failure is non-fatal */
    }
  }
}

export function markActiveThumb() {
  const host = els.thumbs();
  host.querySelectorAll('.thumb').forEach((t) => {
    t.classList.toggle('is-active', Number(t.dataset.page) === S.page);
  });
  const active = host.querySelector('.thumb.is-active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

/* ── Zoom / navigation ──────────────────────────────────────────── */

export async function setZoom(scale) {
  S.zoomMode = 'manual';
  S.zoomScale = Math.min(4, Math.max(0.25, scale));
  await renderPage();
}

export async function zoomIn() { await setZoom(S.zoomScale * 1.2); }
export async function zoomOut() { await setZoom(S.zoomScale / 1.2); }

export async function zoomFit() {
  S.zoomMode = 'fit';
  await renderPage();
}

export async function zoomFitWidth() {
  S.zoomMode = 'fitw';
  await renderPage();
}

export async function gotoPage(n) {
  if (!S.pdf) return;
  const target = Math.min(S.pageCount, Math.max(1, n));
  if (target === S.page) return;
  S.page = target;
  S.selected = null;
  await renderPage();
  markActiveThumb();
  bus.emit('page');
}

/* ── Coordinate conversion ──────────────────────────────────────── */

export function getViewport() { return lastViewport; }

/** Current page size at scale 1, in PDF points. */
export function getBaseSize() { return lastBase; }

/** viewport px (y down) → PDF user space (y up). */
export function toPdfPoint(vx, vy) {
  const [x, y] = lastViewport.convertToPdfPoint(vx, vy);
  return { x, y };
}

/** PDF user space → viewport px. */
export function toViewportPoint(px, py) {
  const [x, y] = lastViewport.convertToViewportPoint(px, py);
  return { x, y };
}

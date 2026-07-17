/**
 * Orion editor — UI wiring: menu bar, toolbars, side panels, modals,
 * keyboard shortcuts, status bar, context menu, and the trial/premium gate.
 */
'use strict';

import {
  S, bus, isPremium, undo, redo, canUndo, canRedo, resetHistory, snapshot,
} from './state.js';
import {
  loadNewDocument, reloadFromBytes,
  zoomIn, zoomOut, zoomFit, zoomFitWidth, setZoom, gotoPage, getBaseSize,
} from './viewer.js';
import {
  redrawOverlay, applyToolCursor, setOverlayPainter,
  deleteSelected, clearSelection, selectAllOnPage, selectedAnnots, pasteAnnots,
} from './annots.js';
import * as ops from './docops.js';
import * as feat from './features.js';
import * as inline from './inline.js';

const CFG = window.ORION_CONFIG || {};
const $ = (id) => document.getElementById(id);

/* ═══════════════════ Small helpers ═══════════════════ */

function toast(msg, cls) {
  const el = document.createElement('div');
  el.className = 'toast' + (cls ? ' ' + cls : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function setStatus(msg) {
  $('status-msg').textContent = msg || 'Ready';
}

function showLoading(text) {
  $('loading-text').textContent = text || 'Working…';
  $('loading-overlay').hidden = false;
}
function hideLoading() {
  $('loading-overlay').hidden = true;
}

function openModal(id) {
  $(id).hidden = false;
}
function closeModals() {
  pendingTrialSource = null;
  document.querySelectorAll('.modal-backdrop').forEach((m) => { m.hidden = true; });
}
function anyModalOpen() {
  return Array.from(document.querySelectorAll('.modal-backdrop')).some((m) => !m.hidden);
}

/* Free-trial session state: a document opened on a free try unlocks
 * every tool for that document. Opening counts the try (see openDocument). */
let trialSessionActive = false;
let pendingTrialSource = null; // { file } | { bytes, name } stashed at the gate

/** Premium, or working on a document opened during a free try. */
function hasAccess() {
  return isPremium() || trialSessionActive;
}

function showUpgrade(reason) {
  $('up-reason').textContent = reason || 'Premium is €1 — unlimited documents, every tool, no badge.';
  $('up-error').hidden = true;
  openModal('modal-upgrade');
}

/** Access gate: true if allowed, else opens the upgrade modal. */
function requirePremium(reason) {
  if (hasAccess()) return true;
  showUpgrade(reason);
  return false;
}

function needDoc() {
  if (S.pdf) return true;
  toast('Open a PDF first', 'is-error');
  return false;
}

/** Run an async op with a busy cursor; toast on failure. */
async function run(fn, failMsg) {
  document.body.style.cursor = 'progress';
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    toast(failMsg || (err && err.message) || 'Something went wrong', 'is-error');
    return undefined;
  } finally {
    document.body.style.cursor = '';
  }
}

async function fileToBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

function fmtKB(n) {
  return n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : Math.round(n / 1024) + ' KB';
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/* ═══════════════════ Reflecting state ═══════════════════ */

const TOOL_NAMES = {
  select: 'Select Tool', selecttext: 'Select Text', hand: 'Hand Tool',
  edittext: 'Edit Text',
  text: 'Add Text', highlighter: 'Highlight', pen: 'Draw', eraser: 'Eraser',
  highlight: 'Highlight Area', rect: 'Rectangle', ellipse: 'Ellipse',
  line: 'Line', arrow: 'Arrow', place: 'Place Item',
};

function updateIndicators() {
  const has = !!S.pdf;
  $('page-input').value = has ? String(S.page) : '1';
  $('page-total').textContent = has ? String(S.pageCount) : '0';
  $('page-info').textContent = has ? S.page + ' / ' + S.pageCount : '0 / 0';
  $('doc-title').textContent = S.fileName || 'No document open';
  $('status-zoom').textContent = has ? Math.round(S.zoomScale * 100) + '%' : '—';
  const base = getBaseSize();
  $('status-pagesize').textContent = has && base
    ? Math.round(base.w) + ' × ' + Math.round(base.h) + ' pt' : '–';

  const sel = $('zoom-select');
  if (S.zoomMode === 'fit') sel.value = 'fit-page';
  else if (S.zoomMode === 'fitw') sel.value = 'fit-width';
  else {
    const near = ['0.5', '0.75', '1', '1.25', '1.5', '2', '3']
      .find((v) => Math.abs(Number(v) - S.zoomScale) < 0.01);
    if (near) sel.value = near;
  }
}

function syncToolButtons() {
  document.querySelectorAll('#tool-buttons .tool-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.tool === S.tool);
  });
  $('status-tool').textContent = TOOL_NAMES[S.tool] || S.tool;
}

function setTool(t) {
  if (t !== 'place') S.pendingImage = null;
  const prev = S.tool;
  S.tool = t;
  inline.onToolChange(t);
  if (prev === 'selecttext' && t !== 'selecttext') feat.clearTextSel();
  if ((t === 'selecttext' || t === 'edittext') && S.pdf) {
    feat.ensureLines(S.page).then(() => redrawOverlay()).catch(() => {});
  }
  applyToolCursor();
  syncToolButtons();
  redrawOverlay(); // dotted text-block boxes toggle with the tool
}

function reflectLicense() {
  const chip = $('license-chip');
  const trial = window.OrionTrial;
  if (isPremium()) {
    chip.textContent = '✦ Premium';
    chip.classList.add('is-premium');
    document.querySelectorAll('.lock').forEach((el) => { el.hidden = true; });
    $('rail-upsell').classList.add('is-hidden');
  } else {
    const left = trial ? trial.remaining() : 0;
    if (trialSessionActive) {
      chip.textContent = left > 0
        ? 'Free try · ' + left + ' left after this'
        : 'Last free try · Premium €1';
    } else {
      chip.textContent = left > 0
        ? 'Free trial · ' + left + (left === 1 ? ' try' : ' tries') + ' left'
        : 'Trial over · Unlock €1';
    }
    chip.classList.remove('is-premium');
    // Tools are unlocked while a free-try document is open.
    if (hasAccess()) {
      document.querySelectorAll('.lock').forEach((el) => { el.hidden = true; });
    }
  }
}

async function updateDocInfo() {
  if (!S.pdf) {
    ['info-pages', 'info-size', 'info-title', 'info-author'].forEach((id) => {
      $(id).textContent = '–';
    });
    return;
  }
  try {
    const info = await ops.getDocumentInfo();
    $('info-pages').textContent = String(info.pages);
    $('info-size').textContent = fmtKB(info.fileSize);
    $('info-title').textContent = info.title || '–';
    $('info-author').textContent = info.author || '–';
  } catch (e) { /* metadata is best-effort */ }
}

/* ═══════════════════ Opening documents (trial gate) ═══════════════════ */

const recents = []; // { name, bytes } — this session only, newest first

function addRecent(name, bytes) {
  const i = recents.findIndex((r) => r.name === name);
  if (i !== -1) recents.splice(i, 1);
  recents.unshift({ name, bytes });
  if (recents.length > 5) recents.pop();
  rebuildRecentMenu();
}

function rebuildRecentMenu() {
  const host = $('recent-items');
  host.innerHTML = '';
  if (!recents.length) {
    const b = document.createElement('button');
    b.className = 'is-disabled';
    b.dataset.action = 'noop';
    b.innerHTML = '<span>No recent files this session</span>';
    host.appendChild(b);
    return;
  }
  recents.forEach((r, idx) => {
    const b = document.createElement('button');
    b.dataset.action = 'recent';
    b.dataset.idx = String(idx);
    const label = document.createElement('span');
    label.textContent = r.name;
    const size = document.createElement('span');
    size.className = 'shortcut';
    size.textContent = fmtKB(r.bytes.length);
    b.append(label, size);
    host.appendChild(b);
  });
}

/** source: { file } | { bytes, name } */
async function openDocument(source) {
  const trial = window.OrionTrial;
  if (!isPremium() && trial && trial.exhausted()) {
    pendingTrialSource = source;
    showUpgrade(
      'Your ' + trial.limit() + ' free tries are used up. Premium is €1 — '
      + 'unlimited documents, every tool, no badge.'
    );
    return;
  }
  await run(async () => {
    const bytes = source.file ? await fileToBytes(source.file) : source.bytes;
    const name = source.file ? source.file.name : source.name;
    await loadNewDocument(bytes, name);
    resetHistory();
    S.dirty = false;
    S.selected = null;
    S.selectedAll = false;
    feat.clearSearch();
    setTool('select');
    addRecent(name, bytes);
    if (!isPremium() && trial) {
      const used = trial.record();
      trialSessionActive = true;
      const left = trial.remaining();
      toast(
        'Loaded ' + name + ' — free try ' + used + ' of ' + trial.limit()
        + (left ? '' : '. Premium is €1 when you want more.'),
        'is-gold'
      );
    } else {
      toast('Loaded ' + name);
    }
    reflectLicense();
    updateDocInfo();
  }, 'Could not open that PDF — it may be password-protected or corrupted.');
}

function openPdfFile(file) {
  return openDocument({ file });
}

async function newBlankPdf() {
  const { PDFDocument } = window.PDFLib;
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]); // US Letter
  const bytes = await doc.save();
  await openDocument({ bytes: new Uint8Array(bytes), name: 'untitled.pdf' });
}

function closeDocument() {
  if (!S.pdf) return;
  if (S.dirty && !window.confirm('Discard unsaved changes?')) return;
  S.pdf = null;
  S.bytes = null;
  S.fileName = '';
  S.pageCount = 0;
  S.page = 1;
  S.pageIds = [];
  S.annots = {};
  S.selected = null;
  S.selectedAll = false;
  S.dirty = false;
  resetHistory();
  feat.clearSearch();
  $('page-wrap').hidden = true;
  $('dropzone').hidden = false;
  $('thumbs').innerHTML = '<p class="panel-empty">No document open</p>';
  $('bookmarks-list').innerHTML = '<p class="panel-empty">No document open</p>';
  $('attachments-list').innerHTML = '<p class="panel-empty">No document open</p>';
  $('annotations-list').innerHTML = '<p class="panel-empty">No annotations</p>';
  updateIndicators();
  updateDocInfo();
  setStatus('Document closed');
}

/* ═══════════════════ Export / print / save-as ═══════════════════ */

function exportPdf() {
  if (!needDoc()) return;
  run(async () => {
    await ops.exportPdf({ badge: !isPremium() });
    toast(isPremium() ? '✦ Exported' : 'Exported — Premium (€1) removes the badge', 'is-gold');
  });
}

function saveAs() {
  if (!needDoc()) return;
  const name = window.prompt('Save as…', ops.baseName() + '-orion.pdf');
  if (!name) return;
  run(async () => {
    const bytes = await ops.buildBurnedBytes({ badge: !isPremium() });
    ops.download(bytes, /\.pdf$/i.test(name) ? name : name + '.pdf');
    S.dirty = false;
    toast('Saved ' + name, 'is-gold');
  });
}

function printDoc() {
  if (!needDoc()) return;
  showLoading('Preparing print…');
  run(() => feat.printPdf({ badge: !isPremium() }), 'Could not open the print dialog')
    .finally(hideLoading);
}

/* ═══════════════════ Images / signature / stamp ═══════════════════ */

function loadImg(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode image'));
    img.src = dataUrl;
  });
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Could not read file'));
    r.readAsDataURL(file);
  });
}

/** PNG/JPEG pass through; WebP is transcoded to PNG for pdf-lib. */
async function prepareImage(file) {
  const raw = await readAsDataUrl(file);
  const img = await loadImg(raw);
  let dataUrl = raw;
  let fmt = file.type === 'image/png' ? 'png' : 'jpg';
  if (file.type === 'image/webp') {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    dataUrl = c.toDataURL('image/png');
    fmt = 'png';
  }
  return { dataUrl, fmt, w: img.naturalWidth, h: img.naturalHeight };
}

function useStamp(label) {
  if (!label || !label.trim()) return;
  S.pendingImage = feat.buildStamp(label.trim().toUpperCase());
  setTool('place');
  closeModals();
  toast('Click or drag on the page to place the stamp', 'is-gold');
}

/* ── Signature pad ── */

const pad = {
  drawing: false, hasInk: false, last: null,
  minX: 1e9, minY: 1e9, maxX: -1e9, maxY: -1e9,
};

function padCanvas() { return $('sign-pad'); }

function padPos(e) {
  const cv = padCanvas();
  const r = cv.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (cv.width / r.width),
    y: (e.clientY - r.top) * (cv.height / r.height),
  };
}

function padExpand(p) {
  pad.minX = Math.min(pad.minX, p.x); pad.maxX = Math.max(pad.maxX, p.x);
  pad.minY = Math.min(pad.minY, p.y); pad.maxY = Math.max(pad.maxY, p.y);
}

function clearPad() {
  const cv = padCanvas();
  cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
  pad.hasInk = false; pad.last = null;
  pad.minX = 1e9; pad.minY = 1e9; pad.maxX = -1e9; pad.maxY = -1e9;
}

function initSignPad() {
  const cv = padCanvas();
  const ctx = cv.getContext('2d');

  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    pad.drawing = true;
    pad.last = padPos(e);
    padExpand(pad.last);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!pad.drawing) return;
    const p = padPos(e);
    ctx.strokeStyle = $('sg-color').value;
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pad.last.x, pad.last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    pad.last = p;
    padExpand(p);
    pad.hasInk = true;
  });
  const stop = () => { pad.drawing = false; };
  cv.addEventListener('pointerup', stop);
  cv.addEventListener('pointercancel', stop);

  $('sg-clear').addEventListener('click', clearPad);

  $('sg-ok').addEventListener('click', () => {
    if (!pad.hasInk) { toast('Draw a signature first', 'is-error'); return; }
    const cv2 = padCanvas();
    const sx = Math.max(0, Math.floor(pad.minX) - 6);
    const sy = Math.max(0, Math.floor(pad.minY) - 6);
    const w = Math.min(cv2.width, Math.ceil(pad.maxX) + 6) - sx;
    const h = Math.min(cv2.height, Math.ceil(pad.maxY) + 6) - sy;
    if (w < 4 || h < 4) { toast('Draw a signature first', 'is-error'); return; }
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    out.getContext('2d').drawImage(cv2, sx, sy, w, h, 0, 0, w, h);
    S.pendingImage = {
      dataUrl: out.toDataURL('image/png'), fmt: 'png', w, h, kind: 'signature',
    };
    setTool('place');
    closeModals();
    toast('Click or drag on the page to place your signature', 'is-gold');
  });
}

/* ═══════════════════ Search / Find & Replace ═══════════════════ */

function updateSearchUi() {
  const n = feat.search.matches.length;
  const has = n > 0;
  $('search-count').hidden = !feat.search.query;
  $('btn-search-prev').hidden = !has;
  $('btn-search-next').hidden = !has;
  $('search-count').textContent = has
    ? (feat.search.current + 1) + ' / ' + n
    : '0 / 0';
}

async function jumpToCurrentMatch() {
  const m = feat.search.matches[feat.search.current];
  if (!m) return;
  await gotoPage(m.page);
  redrawOverlay();
  updateSearchUi();
}

async function doSearch(query) {
  if (!needDoc()) return;
  if (!query || !query.trim()) return;
  showLoading('Searching…');
  try {
    await feat.runSearch(query.trim());
    const n = feat.search.matches.length;
    if (n) {
      toast('Found ' + n + ' match' + (n === 1 ? '' : 'es'), 'is-gold');
      await jumpToCurrentMatch();
    } else {
      toast('No matches for “' + query.trim() + '”', 'is-error');
      redrawOverlay();
      updateSearchUi();
    }
  } catch (err) {
    console.error(err);
    toast('Could not search this document', 'is-error');
  } finally {
    hideLoading();
  }
}

function stepMatch(dir) {
  if (!feat.search.matches.length) return;
  feat.stepSearch(dir);
  jumpToCurrentMatch();
}

function frStatus(msg) {
  $('fr-status').textContent = msg || '';
}

async function frFindNext() {
  const q = $('fr-find').value.trim();
  if (!q) return;
  if (feat.search.query !== q || !feat.search.matches.length) {
    await feat.runSearch(q);
  } else {
    feat.stepSearch(1);
  }
  const n = feat.search.matches.length;
  frStatus(n ? 'Match ' + (feat.search.current + 1) + ' of ' + n : 'No matches');
  $('search-input').value = q;
  updateSearchUi();
  if (n) await jumpToCurrentMatch();
}

async function frReplaceOne() {
  if (!requirePremium('Find & Replace edits the PDF — part of Premium (€1).')) return;
  const q = $('fr-find').value.trim();
  const r = $('fr-replace').value;
  if (!q) return;
  if (feat.search.query !== q || !feat.search.matches.length) {
    await feat.runSearch(q);
  }
  const m = feat.search.matches[feat.search.current];
  if (!m) { frStatus('No matches'); return; }
  showLoading('Replacing…');
  try {
    await feat.replaceMatch(m, r);
    await feat.runSearch(q);
    const n = feat.search.matches.length;
    frStatus(n ? n + ' match' + (n === 1 ? '' : 'es') + ' left' : 'All replaced ✓');
    updateSearchUi();
    if (n) await jumpToCurrentMatch(); else redrawOverlay();
  } finally {
    hideLoading();
  }
}

async function frReplaceAll() {
  if (!requirePremium('Find & Replace edits the PDF — part of Premium (€1).')) return;
  const q = $('fr-find').value.trim();
  const r = $('fr-replace').value;
  if (!q) return;
  showLoading('Replacing all…');
  try {
    const count = await feat.replaceAll(q, r, (n) => {
      $('loading-text').textContent = 'Replacing… ' + n;
    });
    frStatus(count ? 'Replaced ' + count + ' occurrence' + (count === 1 ? '' : 's') + ' ✓' : 'No matches');
    updateSearchUi();
    redrawOverlay();
    if (count) toast('Replaced ' + count + ' occurrence' + (count === 1 ? '' : 's'), 'is-gold');
  } finally {
    hideLoading();
  }
}

/* ═══════════════════ Side panels ═══════════════════ */

const PANELS = ['pages', 'marks', 'files', 'notes'];

function showPanel(name) {
  $('sidebar').classList.remove('is-collapsed');
  $('sidebar-toggle-glyph').textContent = '‹';
  document.querySelectorAll('.side-icons .sidebar-item[data-panel]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.panel === name);
  });
  PANELS.forEach((p) => { $('panel-' + p + '-content').hidden = p !== name; });
  if (name === 'marks') refreshBookmarks();
  if (name === 'files') refreshAttachments();
  if (name === 'notes') refreshNotes();
}

function activePanel() {
  const btn = document.querySelector('.side-icons .sidebar-item.is-active[data-panel]');
  return btn ? btn.dataset.panel : 'pages';
}

async function refreshBookmarks() {
  const host = $('bookmarks-list');
  if (!S.pdf) { host.innerHTML = '<p class="panel-empty">No document open</p>'; return; }
  host.innerHTML = '<p class="panel-empty">Reading outline…</p>';
  const items = await run(() => feat.readBookmarks()) || [];
  host.innerHTML = '';
  if (!items.length) {
    host.innerHTML = '<p class="panel-empty">No bookmarks in this document</p>';
    return;
  }
  items.forEach((it) => {
    const b = document.createElement('button');
    b.className = 'bm-item' + (it.level > 1 ? ' bm-l' + Math.min(it.level, 3) : '');
    b.textContent = it.title;
    b.title = it.title + (it.page ? ' — page ' + it.page : '');
    if (it.page) b.addEventListener('click', () => gotoPage(it.page));
    host.appendChild(b);
  });
}

async function refreshAttachments() {
  const host = $('attachments-list');
  if (!S.pdf) { host.innerHTML = '<p class="panel-empty">No document open</p>'; return; }
  host.innerHTML = '<p class="panel-empty">Scanning…</p>';
  const items = await run(() => feat.readAttachments()) || [];
  host.innerHTML = '';
  if (!items.length) {
    host.innerHTML = '<p class="panel-empty">No attachments</p>';
    return;
  }
  items.forEach((it) => {
    const b = document.createElement('button');
    b.className = 'att-item';
    const name = document.createElement('span');
    name.textContent = '⎘ ' + it.name;
    const size = document.createElement('span');
    size.className = 'att-size';
    size.textContent = fmtKB(it.bytes.length);
    b.append(name, size);
    b.title = 'Download ' + it.name;
    b.addEventListener('click', () => {
      const blob = new Blob([it.bytes]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = it.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    });
    host.appendChild(b);
  });
}

function refreshNotes() {
  const host = $('annotations-list');
  if (!S.pdf) { host.innerHTML = '<p class="panel-empty">No document open</p>'; return; }
  host.innerHTML = '';
  let count = 0;
  S.pageIds.forEach((pid, idx) => {
    (S.annots[pid] || []).forEach((a) => {
      count += 1;
      const b = document.createElement('button');
      b.className = 'note-item';
      const page = document.createElement('span');
      page.className = 'note-page';
      page.textContent = 'P' + (idx + 1);
      const label = document.createElement('span');
      label.textContent = a.type === 'text'
        ? '“' + String(a.value).slice(0, 26) + (String(a.value).length > 26 ? '…' : '') + '”'
        : a.type === 'image' ? (a.kind === 'signature' ? 'signature' : 'image')
          : a.type;
      b.append(page, label);
      b.addEventListener('click', () => gotoPage(idx + 1));
      host.appendChild(b);
    });
  });
  if (!count) host.innerHTML = '<p class="panel-empty">No annotations</p>';
}

/* ═══════════════════ Forms panel ═══════════════════ */

async function scanForms() {
  if (!S.pdf) return;
  const host = $('form-fields');
  const fields = await run(() => ops.listFormFields(), 'Could not read form fields');
  if (!fields) return;

  if (!fields.length) {
    host.innerHTML = '<p class="p-hint">No form fields in this document.</p>';
    $('btn-forms-apply').hidden = true;
    return;
  }

  host.innerHTML = '';
  fields.forEach((f) => {
    const wrap = document.createElement('div');
    wrap.className = 'form-field';
    const label = document.createElement('label');
    label.textContent = f.name;
    wrap.appendChild(label);

    let input = null;
    if (f.kind === 'text') {
      input = document.createElement('input');
      input.type = 'text';
      input.className = 'p-input';
      input.value = f.value;
    } else if (f.kind === 'checkbox') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!f.value;
    } else if (f.kind === 'dropdown' || f.kind === 'radio') {
      input = document.createElement('select');
      input.className = 'p-input';
      const opts = f.options || [];
      if (!f.value) {
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = '—';
        input.appendChild(blank);
      }
      opts.forEach((o) => {
        const opt = document.createElement('option');
        opt.value = o;
        opt.textContent = o;
        if (o === f.value) opt.selected = true;
        input.appendChild(opt);
      });
    } else {
      const p = document.createElement('p');
      p.className = 'p-hint';
      p.textContent = '(unsupported field type)';
      wrap.appendChild(p);
      host.appendChild(wrap);
      return;
    }
    input.dataset.name = f.name;
    input.dataset.kind = f.kind;
    wrap.appendChild(input);
    host.appendChild(wrap);
  });
  $('btn-forms-apply').hidden = false;
}

/* ═══════════════════ Properties & preferences modals ═══════════════════ */

async function showProperties() {
  if (!needDoc()) return;
  const info = await run(() => ops.getDocumentInfo(), 'Could not read document properties');
  if (!info) return;
  const rows = [
    ['Title', info.title], ['Author', info.author],
    ['Subject', info.subject], ['Keywords', info.keywords],
    ['Creator', info.creator], ['Producer', info.producer],
    ['Creation Date', info.created], ['Modified Date', info.modified],
    ['Pages', String(info.pages)], ['File Size', fmtKB(info.fileSize)],
    ['PDF Version', info.version], ['Page Size', info.pageSize],
  ];
  const grid = $('props-grid');
  grid.innerHTML = '';
  rows.forEach(([label, value]) => {
    const cell = document.createElement('div');
    const l = document.createElement('div');
    l.className = 'pg-label';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'pg-value';
    v.textContent = value || '–';
    cell.append(l, v);
    grid.appendChild(cell);
  });
  openModal('modal-props');
}

function openPrefs() {
  const p = feat.loadPrefs();
  $('pf-color').value = p.color || S.color;
  $('pf-size').value = p.fontSize || S.fontSize;
  $('pf-font').value = p.fontFamily || S.fontFamily;
  $('pf-author').value = p.author || '';
  openModal('modal-prefs');
}

function savePrefsFromModal() {
  const p = {
    color: $('pf-color').value,
    fontSize: clamp(parseInt($('pf-size').value, 10) || 16, 6, 96),
    fontFamily: $('pf-font').value,
    author: $('pf-author').value.trim(),
  };
  feat.savePrefs(p);
  S.color = p.color;
  S.fontSize = p.fontSize;
  S.fontFamily = p.fontFamily;
  syncPropsUi();
  closeModals();
  toast('Preferences saved', 'is-gold');
}

function syncPropsUi() {
  $('prop-color').value = S.color;
  $('prop-width').value = String(S.strokeWidth);
  $('width-value').textContent = S.strokeWidth + ' px';
  $('prop-size').value = String(S.fontSize);
  $('size-value').textContent = S.fontSize + ' pt';
  $('prop-opacity').value = String(Math.round(S.opacity * 100));
  $('opacity-value').textContent = Math.round(S.opacity * 100) + '%';
  $('prop-font').value = S.fontFamily;
  document.querySelectorAll('.color-swatch[data-color]').forEach((sw) => {
    sw.classList.toggle('is-active', sw.dataset.color.toLowerCase() === S.color.toLowerCase());
  });
}

/* ═══════════════════ Clipboard ═══════════════════ */

let clipboard = [];

function doCopy() {
  if (feat.hasTextSel()) {
    const t = feat.selectedText();
    navigator.clipboard.writeText(t).then(
      () => toast('Copied ' + t.length + ' character' + (t.length === 1 ? '' : 's')),
      () => toast('Could not access the clipboard', 'is-error'),
    );
    return;
  }
  const items = selectedAnnots();
  if (!items.length) { toast('Nothing selected — click an annotation first', 'is-error'); return; }
  clipboard = items;
  toast('Copied ' + items.length + ' annotation' + (items.length === 1 ? '' : 's'));
}

function doCut() {
  if (feat.hasTextSel()) { doCopy(); return; } // page text can't be cut, only copied
  const items = selectedAnnots();
  if (!items.length) { toast('Nothing selected — click an annotation first', 'is-error'); return; }
  clipboard = items;
  deleteSelected();
  toast('Cut ' + items.length + ' annotation' + (items.length === 1 ? '' : 's'));
}

function doPaste() {
  if (!needDoc()) return;
  if (!clipboard.length) { toast('Clipboard is empty', 'is-error'); return; }
  const n = pasteAnnots(clipboard);
  toast('Pasted ' + n + ' annotation' + (n === 1 ? '' : 's'), 'is-gold');
}

function doSelectAll() {
  if (!needDoc()) return;
  if (S.tool === 'selecttext') {
    run(async () => {
      await feat.ensureLines(S.page);
      const n = feat.selectAllText();
      redrawOverlay();
      toast(n ? n + ' characters selected — Ctrl+C to copy' : 'No text on this page');
    });
    return;
  }
  const n = selectAllOnPage();
  toast(n ? n + ' annotation' + (n === 1 ? '' : 's') + ' selected' : 'No annotations on this page');
}

/* ═══════════════════ Page operations ═══════════════════ */

function deletePageConfirm() {
  if (!needDoc()) return;
  if (!window.confirm('Delete page ' + S.page + '?')) return;
  run(() => ops.deletePage(S.page - 1));
}

function duplicateCurrentPage() {
  if (!needDoc()) return;
  run(async () => {
    await ops.duplicatePage(S.page - 1);
    toast('Page ' + S.page + ' duplicated', 'is-gold');
  });
}

function insertBlank(where) {
  if (!needDoc()) return;
  run(async () => {
    await ops.insertBlankPage(S.page - 1, where);
    toast('Blank page inserted ' + where, 'is-gold');
  });
}

function extractCurrentPage() {
  if (!needDoc()) return;
  if (!requirePremium('Page extraction is a Premium tool — €1 unlocks everything.')) return;
  run(async () => {
    await ops.extractRange(String(S.page));
    toast('Page ' + S.page + ' extracted — check your downloads', 'is-gold');
  });
}

function clearAllAnnotations() {
  if (!needDoc()) return;
  if (!window.confirm('Clear ALL annotations on every page?')) return;
  snapshot();
  S.annots = {};
  S.selected = null;
  S.selectedAll = false;
  bus.emit('annots-changed');
  redrawOverlay();
  toast('All annotations cleared');
}

function runOptimize() {
  if (!needDoc()) return;
  if (!requirePremium('File optimization is a Premium tool — €1 unlocks everything.')) return;
  run(async () => {
    const r = await ops.optimize();
    const el = $('opt-result');
    if (r.applied) {
      const pct = Math.round((1 - r.after / r.before) * 100);
      el.textContent = fmtKB(r.before) + ' → ' + fmtKB(r.after) + ' (−' + pct + '%)';
      toast('Optimized — saved ' + pct + '%', 'is-gold');
    } else {
      el.textContent = 'Already compact — no savings found.';
      toast('Already compact — no savings found.');
    }
  });
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {
      toast('Full screen was blocked by the browser', 'is-error');
    });
  } else {
    document.exitFullscreen();
  }
}

/* ═══════════════════ Menu system & actions ═══════════════════ */

let openMenu = null;

function closeMenus() {
  document.querySelectorAll('.menu-dropdown').forEach((m) => { m.hidden = true; });
  document.querySelectorAll('.menu-trigger').forEach((t) => t.classList.remove('is-open'));
  openMenu = null;
}

function initMenus() {
  document.querySelectorAll('.menu-container').forEach((container) => {
    const trigger = container.querySelector('.menu-trigger');
    const dropdown = container.querySelector('.menu-dropdown');

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openMenu === dropdown) { closeMenus(); return; }
      closeMenus();
      dropdown.hidden = false;
      trigger.classList.add('is-open');
      openMenu = dropdown;
    });
    trigger.addEventListener('mouseenter', () => {
      if (openMenu && openMenu !== dropdown) {
        closeMenus();
        dropdown.hidden = false;
        trigger.classList.add('is-open');
        openMenu = dropdown;
      }
    });
  });
  document.addEventListener('click', () => {
    closeMenus();
    $('context-menu').hidden = true;
  });
}

const ACTIONS = {
  'noop': () => {},
  'open': () => $('file-open').click(),
  'recent': (el) => {
    const r = recents[Number(el.dataset.idx)];
    if (r) openDocument({ bytes: r.bytes, name: r.name });
  },
  'new-blank': () => run(() => newBlankPdf(), 'Could not create a blank PDF'),
  'save': () => exportPdf(),
  'save-as': () => saveAs(),
  'print': () => printDoc(),
  'close-doc': () => closeDocument(),
  'properties': () => showProperties(),
  'exit': () => {
    if (S.dirty && !window.confirm('Discard unsaved changes?')) return;
    S.dirty = false; // confirmed once — don't let beforeunload ask again
    window.location.href = 'index.html';
  },
  'undo': () => undo(),
  'redo': () => redo(),
  'cut': () => doCut(),
  'copy': () => doCopy(),
  'paste': () => doPaste(),
  'delete-sel': () => { if (!deleteSelected()) toast('Nothing selected', 'is-error'); },
  'select-all': () => doSelectAll(),
  'find': () => { $('search-input').focus(); },
  'find-replace': () => {
    if (!needDoc()) return;
    $('fr-find').value = $('search-input').value;
    frStatus('');
    openModal('modal-replace');
    $('fr-find').focus();
  },
  'prefs': () => openPrefs(),
  'zoom-in': () => { if (S.pdf) zoomIn(); },
  'zoom-out': () => { if (S.pdf) zoomOut(); },
  'zoom-actual': () => { if (S.pdf) setZoom(1); },
  'fit-width': () => { if (S.pdf) zoomFitWidth(); },
  'fit-page': () => { if (S.pdf) zoomFit(); },
  'rotate-cw': () => { if (needDoc()) run(() => ops.rotatePage(S.page - 1, 90)); },
  'rotate-ccw': () => { if (needDoc()) run(() => ops.rotatePage(S.page - 1, -90)); },
  'panel-pages': () => showPanel('pages'),
  'panel-marks': () => showPanel('marks'),
  'panel-files': () => showPanel('files'),
  'panel-notes': () => showPanel('notes'),
  'fullscreen': () => toggleFullscreen(),
  'tool-select': () => setTool('select'),
  'tool-selecttext': () => { if (needDoc()) setTool('selecttext'); },
  'tool-hand': () => setTool('hand'),
  'tool-edittext': () => { if (needDoc()) setTool('edittext'); },
  'tool-text': () => setTool('text'),
  'tool-highlighter': () => setTool('highlighter'),
  'tool-pen': () => setTool('pen'),
  'tool-eraser': () => setTool('eraser'),
  'sign': () => {
    if (!needDoc()) return;
    if (!requirePremium('Signatures are a Premium tool — €1 unlocks everything.')) return;
    clearPad();
    openModal('modal-sign');
  },
  'stamp': () => {
    if (!needDoc()) return;
    if (!requirePremium('Stamps are a Premium tool — €1 unlocks everything.')) return;
    $('stamp-custom').value = '';
    openModal('modal-stamp');
  },
  'merge': () => $('btn-merge').click(),
  'encrypt': () => openModal('modal-encrypt'),
  'optimize': () => runOptimize(),
  'docs': () => openModal('modal-docs'),
  'shortcuts': () => openModal('modal-shortcuts'),
  'about': () => openModal('modal-about'),
  'duplicate-page': () => duplicateCurrentPage(),
  'delete-page': () => deletePageConfirm(),
  'extract-current': () => extractCurrentPage(),
  'insert-before': () => insertBlank('before'),
  'insert-after': () => insertBlank('after'),
};

function dispatchAction(el) {
  const action = el.dataset.action;
  const fn = ACTIONS[action];
  if (!fn) return;
  if (action === 'noop') return; // keep the menu open (submenu parent)
  closeMenus();
  $('context-menu').hidden = true;
  fn(el);
}

/* ═══════════════════ Context menu ═══════════════════ */

function ctxItem(label, action, shortcut) {
  return '<button data-action="' + action + '"><span>' + label + '</span>'
    + '<span class="shortcut">' + (shortcut || '') + '</span></button>';
}

function showContextMenu(x, y) {
  const menu = $('context-menu');
  menu.innerHTML = S.pdf
    ? ctxItem('Rotate Clockwise', 'rotate-cw')
      + ctxItem('Rotate Counter-Clockwise', 'rotate-ccw')
      + '<div class="divider"></div>'
      + ctxItem('Duplicate Page', 'duplicate-page')
      + ctxItem('Delete Page', 'delete-page')
      + ctxItem('Extract Page', 'extract-current')
      + '<div class="divider"></div>'
      + ctxItem('Insert Blank Before', 'insert-before')
      + ctxItem('Insert Blank After', 'insert-after')
      + '<div class="divider"></div>'
      + ctxItem('Paste', 'paste', 'Ctrl+V')
      + ctxItem('Properties…', 'properties', 'Ctrl+D')
    : ctxItem('Open PDF…', 'open', 'Ctrl+O')
      + ctxItem('New Blank PDF', 'new-blank');
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}

/* ═══════════════════ Main init ═══════════════════ */

export function initUI() {
  feat.applyPrefs();
  initMenus();

  // Overlay decorations that must survive every redraw (gesture previews,
  // zooms, tool changes): dotted text-block boxes, the live text selection,
  // and search highlights.
  setOverlayPainter((ctx) => {
    feat.paintTextBlocks(ctx);
    feat.paintTextSel(ctx);
    feat.paintSearchHighlights(ctx);
  });
  inline.initInline({ run, toast });

  /* ── Global action dispatch (menus, toolbar, context menu, rail) ── */
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (el) {
      e.stopPropagation();
      dispatchAction(el);
    }
  }, true);

  /* ── Open / merge / drop ── */
  $('btn-open-2').addEventListener('click', () => $('file-open').click());
  $('btn-new-blank').addEventListener('click', () => run(() => newBlankPdf()));
  $('file-open').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) openPdfFile(file);
  });

  $('btn-merge').addEventListener('click', () => {
    if (!needDoc()) return;
    if (!requirePremium('Merging is part of Premium — €1, everything unlocked.')) return;
    $('file-merge').click();
  });
  $('file-merge').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    run(async () => {
      const bytes = await fileToBytes(file);
      const n = await ops.mergeBytes(bytes, file.name);
      toast('Merged ' + n + ' page' + (n === 1 ? '' : 's') + ' from ' + file.name, 'is-gold');
    }, 'Could not merge that PDF — it may be password-protected.');
  });

  window.addEventListener('dragover', (e) => {
    if (Array.from(e.dataTransfer.types || []).includes('Files')) {
      e.preventDefault();
      $('dropzone').classList.add('is-over');
    }
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) $('dropzone').classList.remove('is-over');
  });
  window.addEventListener('drop', (e) => {
    $('dropzone').classList.remove('is-over');
    if (!e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) openPdfFile(file);
    else toast('Drop a PDF file', 'is-error');
  });

  /* ── Undo / redo ── */
  bus.on('history', () => {
    $('btn-undo').disabled = !canUndo();
    $('btn-redo').disabled = !canRedo();
  });
  bus.on('restored', () => {
    run(() => reloadFromBytes(S.bytes));
  });

  /* ── Navigation / zoom ── */
  $('btn-prev').addEventListener('click', () => gotoPage(S.page - 1));
  $('btn-next').addEventListener('click', () => gotoPage(S.page + 1));
  $('page-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const n = parseInt($('page-input').value, 10);
      if (!isNaN(n)) gotoPage(n);
      $('page-input').blur();
    }
  });
  $('page-input').addEventListener('blur', () => updateIndicators());

  $('btn-zoom-in').addEventListener('click', () => { if (S.pdf) zoomIn(); });
  $('btn-zoom-out').addEventListener('click', () => { if (S.pdf) zoomOut(); });
  $('zoom-select').addEventListener('change', (e) => {
    if (!S.pdf) return;
    const v = e.target.value;
    if (v === 'fit-page') zoomFit();
    else if (v === 'fit-width') zoomFitWidth();
    else setZoom(parseFloat(v));
  });

  /* ── Tools & properties ── */
  document.querySelectorAll('#tool-buttons .tool-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const t = b.dataset.tool;
      if ((t === 'edittext' || t === 'selecttext') && !S.pdf) { toast('Open a PDF first', 'is-error'); return; }
      setTool(t);
    });
  });
  bus.on('tool', syncToolButtons);

  document.querySelectorAll('.color-swatch[data-color]').forEach((sw) => {
    sw.addEventListener('click', () => {
      S.color = sw.dataset.color;
      syncPropsUi();
    });
  });
  $('prop-color').addEventListener('input', (e) => {
    S.color = e.target.value;
    document.querySelectorAll('.color-swatch[data-color]').forEach((sw) => sw.classList.remove('is-active'));
  });
  $('prop-width').addEventListener('input', (e) => {
    S.strokeWidth = Number(e.target.value);
    $('width-value').textContent = S.strokeWidth + ' px';
  });
  $('prop-size').addEventListener('input', (e) => {
    S.fontSize = clamp(parseInt(e.target.value, 10) || 16, 6, 96);
    $('size-value').textContent = S.fontSize + ' pt';
  });
  $('prop-opacity').addEventListener('input', (e) => {
    S.opacity = clamp(parseInt(e.target.value, 10) || 100, 10, 100) / 100;
    $('opacity-value').textContent = Math.round(S.opacity * 100) + '%';
  });
  $('prop-font').addEventListener('change', (e) => {
    S.fontFamily = e.target.value;
  });

  /* ── Page structure (toolbar + sidebar grid) ── */
  $('btn-rotate-l').addEventListener('click', () => ACTIONS['rotate-ccw']());
  $('btn-rotate-r').addEventListener('click', () => ACTIONS['rotate-cw']());
  $('btn-rotate-l-2').addEventListener('click', () => ACTIONS['rotate-ccw']());
  $('btn-rotate-r-2').addEventListener('click', () => ACTIONS['rotate-cw']());
  $('btn-delete-page').addEventListener('click', deletePageConfirm);
  $('btn-delete-page-2').addEventListener('click', deletePageConfirm);
  $('btn-duplicate-page').addEventListener('click', duplicateCurrentPage);
  $('btn-duplicate-page-2').addEventListener('click', duplicateCurrentPage);
  $('btn-extract-page').addEventListener('click', extractCurrentPage);
  $('btn-insert-before').addEventListener('click', () => insertBlank('before'));
  $('btn-insert-after').addEventListener('click', () => insertBlank('after'));

  /* ── Thumbnails: click to jump, drag to reorder ── */
  const thumbs = $('thumbs');
  let dragFrom = null;

  thumbs.addEventListener('click', (e) => {
    const t = e.target.closest('.thumb');
    if (t) gotoPage(Number(t.dataset.page));
  });
  thumbs.addEventListener('dragstart', (e) => {
    const t = e.target.closest('.thumb');
    if (!t) return;
    dragFrom = Number(t.dataset.page);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', t.dataset.page);
  });
  thumbs.addEventListener('dragover', (e) => {
    const t = e.target.closest('.thumb');
    if (!t || dragFrom == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    t.classList.add('drag-over');
  });
  thumbs.addEventListener('dragleave', (e) => {
    const t = e.target.closest('.thumb');
    if (t) t.classList.remove('drag-over');
  });
  thumbs.addEventListener('drop', (e) => {
    const t = e.target.closest('.thumb');
    if (!t || dragFrom == null) return;
    e.preventDefault();
    e.stopPropagation();
    const from = dragFrom;
    const to = Number(t.dataset.page);
    dragFrom = null;
    thumbs.querySelectorAll('.drag-over').forEach((x) => x.classList.remove('drag-over'));
    if (from !== to) run(() => ops.movePage(from - 1, to - 1));
  });
  thumbs.addEventListener('dragend', () => {
    dragFrom = null;
    thumbs.querySelectorAll('.drag-over').forEach((x) => x.classList.remove('drag-over'));
  });

  /* ── Side panels ── */
  document.querySelectorAll('.side-icons .sidebar-item[data-panel]').forEach((b) => {
    b.addEventListener('click', () => showPanel(b.dataset.panel));
  });
  $('btn-toggle-sidebar').addEventListener('click', () => {
    const sb = $('sidebar');
    sb.classList.toggle('is-collapsed');
    $('sidebar-toggle-glyph').textContent = sb.classList.contains('is-collapsed') ? '›' : '‹';
  });

  /* ── License / upgrade ── */
  $('license-chip').addEventListener('click', () => {
    if (isPremium()) { toast('✦ Premium is active on this device', 'is-gold'); return; }
    showUpgrade('Premium is €1 — unlimited documents, every tool, no badge.');
  });
  $('btn-upsell').addEventListener('click', () => {
    showUpgrade('Premium is €1 — unlimited documents, every tool, no badge.');
  });
  $('btn-buy-now').addEventListener('click', () => {
    const link = CFG.premiumPaymentLink;
    if (link) window.open(link, '_blank', 'noopener');
    else toast('No payment link configured yet — see the README. You can activate a key below.');
  });
  $('btn-activate-key').addEventListener('click', () => {
    const ok = window.OrionLicense && window.OrionLicense.activate($('up-key').value);
    if (ok) {
      const pending = pendingTrialSource;
      closeModals();
      reflectLicense();
      toast('✦ Premium active — thank you!', 'is-gold');
      if (pending) openDocument(pending);
    } else {
      $('up-error').hidden = false;
    }
  });
  $('up-key').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-activate-key').click();
  });

  /* ── Sign / image / stamp ── */
  $('btn-sign').addEventListener('click', () => ACTIONS['sign']());
  initSignPad();

  $('btn-image').addEventListener('click', () => {
    if (!needDoc()) return;
    if (!requirePremium('Image insertion is a Premium tool — €1 unlocks everything.')) return;
    $('file-image').click();
  });
  $('file-image').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    run(async () => {
      const info = await prepareImage(file);
      S.pendingImage = {
        dataUrl: info.dataUrl, fmt: info.fmt, w: info.w, h: info.h, kind: 'image',
      };
      setTool('place');
      toast('Click or drag on the page to place the image', 'is-gold');
    }, 'Could not read that image.');
  });

  $('btn-stamp').addEventListener('click', () => ACTIONS['stamp']());
  document.querySelectorAll('.stamp-opt').forEach((b) => {
    b.addEventListener('click', () => useStamp(b.dataset.stamp));
  });
  $('stamp-custom-ok').addEventListener('click', () => useStamp($('stamp-custom').value));
  $('stamp-custom').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') useStamp($('stamp-custom').value);
  });

  /* ── Inline text editing (Add Text / Edit Text / edit annotation) ── */
  bus.on('text-annot-request', ({ vx, vy }) => {
    if (inline.isEditing()) { inline.commitActive(); return; } // click commits, next click spawns
    inline.beginAddText(vx, vy);
  });
  bus.on('edit-text-annot', ({ index }) => inline.beginEditAnnot(index));
  bus.on('edit-pdf-text-request', async ({ vx, vy }) => {
    if (inline.isEditing()) { inline.commitActive(); return; }
    const ok = await run(() => inline.beginEditPageText(vx, vy), 'Could not read the page text');
    if (ok === false) toast('No text found at this spot', 'is-error');
  });

  /* ── Live text selection (Select Text tool) ── */
  bus.on('textsel', ({ phase, vx, vy }) => {
    if (phase === 'begin') {
      feat.beginTextSel(vx, vy);
      redrawOverlay();
    } else if (phase === 'move') {
      feat.extendTextSel(vx, vy);
      redrawOverlay();
    } else if (phase === 'end') {
      feat.extendTextSel(vx, vy);
      redrawOverlay();
      const n = feat.selectedText().length;
      setStatus(n ? n + ' character' + (n === 1 ? '' : 's') + ' selected — Ctrl+C to copy' : 'Ready');
    }
  });
  bus.on('text-lines-ready', () => redrawOverlay());

  /* ── Search / find & replace ── */
  $('search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = $('search-input').value;
      if (feat.search.query === q.trim() && feat.search.matches.length) stepMatch(1);
      else doSearch(q);
    }
  });
  $('btn-search-next').addEventListener('click', () => stepMatch(1));
  $('btn-search-prev').addEventListener('click', () => stepMatch(-1));
  $('fr-find-next').addEventListener('click', () => run(() => frFindNext()));
  $('fr-replace-one').addEventListener('click', () => run(() => frReplaceOne()));
  $('fr-replace-all').addEventListener('click', () => run(() => frReplaceAll()));

  /* ── Pro rail panels ── */
  $('btn-watermark').addEventListener('click', () => {
    if (!needDoc()) return;
    if (!requirePremium('Watermarks are a Premium tool — €1 unlocks everything.')) return;
    const text = $('wm-text').value.trim() || 'CONFIDENTIAL';
    run(async () => {
      await ops.addWatermark(text, {
        colorHex: $('wm-color').value,
        opacity: Number($('wm-opacity').value) / 100,
      });
      toast('Watermark stamped on every page', 'is-gold');
    });
  });

  $('btn-numbers').addEventListener('click', () => {
    if (!needDoc()) return;
    if (!requirePremium('Page numbering is a Premium tool — €1 unlocks everything.')) return;
    run(async () => {
      await ops.addPageNumbers({ format: $('pn-format').value });
      toast('Pages numbered', 'is-gold');
    });
  });

  $('btn-extract').addEventListener('click', () => {
    if (!needDoc()) return;
    if (!requirePremium('Page extraction is a Premium tool — €1 unlocks everything.')) return;
    run(async () => {
      const n = await ops.extractRange($('ex-range').value);
      toast('Extracted ' + n + ' page' + (n === 1 ? '' : 's') + ' — check your downloads', 'is-gold');
    });
  });

  $('panel-forms').addEventListener('toggle', () => {
    if ($('panel-forms').open) scanForms();
  });
  $('btn-forms-apply').addEventListener('click', () => {
    if (!needDoc()) return;
    if (!requirePremium('Form filling is a Premium tool — €1 unlocks everything.')) return;
    const values = Array.from($('form-fields').querySelectorAll('[data-name]')).map((el) => ({
      name: el.dataset.name,
      kind: el.dataset.kind,
      value: el.dataset.kind === 'checkbox' ? el.checked : el.value,
    }));
    run(async () => {
      await ops.applyFormValues(values);
      toast('Form values written into the PDF', 'is-gold');
    });
  });

  $('panel-meta').addEventListener('toggle', () => {
    if (!$('panel-meta').open || !S.pdf) return;
    run(async () => {
      const m = await ops.getMetadata();
      $('md-title').value = m.title;
      $('md-author').value = m.author || feat.loadPrefs().author || '';
      $('md-subject').value = m.subject;
      $('md-keywords').value = m.keywords;
    });
  });
  $('btn-meta').addEventListener('click', () => {
    if (!needDoc()) return;
    if (!requirePremium('Metadata editing is a Premium tool — €1 unlocks everything.')) return;
    run(async () => {
      await ops.setMetadata({
        title: $('md-title').value,
        author: $('md-author').value,
        subject: $('md-subject').value,
        keywords: $('md-keywords').value,
      });
      toast('Metadata saved into the file', 'is-gold');
    });
  });

  $('btn-optimize').addEventListener('click', runOptimize);
  $('btn-flatten').addEventListener('click', exportPdf);
  $('btn-clear-annots').addEventListener('click', clearAllAnnotations);

  /* ── Preferences ── */
  $('pf-save').addEventListener('click', savePrefsFromModal);

  /* ── Export ── */
  $('btn-export-png').addEventListener('click', () => {
    if (!needDoc()) return;
    $('page-canvas').toBlob((blob) => {
      if (!blob) { toast('Could not export PNG', 'is-error'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = ops.baseName() + '-page' + S.page + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }, 'image/png');
  });
  $('btn-export-pdf').addEventListener('click', exportPdf);

  /* ── Context menu ── */
  $('stage').addEventListener('contextmenu', (e) => {
    e.preventDefault();
    closeMenus();
    showContextMenu(e.clientX, e.clientY);
  });

  /* ── Modal close (delegated) ── */
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('js-close') || e.target.closest('.js-close')
      || e.target.classList.contains('modal-backdrop')) {
      closeModals();
    }
  });

  /* ── Keyboard shortcuts ── */
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (openMenu) { closeMenus(); return; }
      if (!$('context-menu').hidden) { $('context-menu').hidden = true; return; }
      if (anyModalOpen()) { closeModals(); return; }
      if (inline.isEditing()) { inline.cancelActive(); return; }
      if (feat.search.matches.length || feat.search.query) {
        feat.clearSearch();
        updateSearchUi();
        redrawOverlay();
        return;
      }
      if (feat.hasTextSel()) {
        feat.clearTextSel();
        redrawOverlay();
        return;
      }
      if (S.tool === 'place' || S.tool === 'text') { setTool('select'); return; }
      clearSelection();
      return;
    }

    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select'
      || e.target.isContentEditable;

    /* Function keys work everywhere except while typing. */
    if (!typing) {
      if (e.key === 'F1') { e.preventDefault(); openModal('modal-docs'); return; }
      if (e.key === 'F4') { e.preventDefault(); showPanel('pages'); return; }
      if (e.key === 'F11') { e.preventDefault(); toggleFullscreen(); return; }
    }

    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if ((k === 'z' || k === 'y') && typing) return; // native undo in inputs
      if ((k === 'c' || k === 'x' || k === 'v' || k === 'a') && typing) return; // native clipboard

      if (e.shiftKey && (e.key === '+' || e.key === '=')) { e.preventDefault(); ACTIONS['rotate-cw'](); }
      else if (e.shiftKey && (e.key === '-' || e.key === '_')) { e.preventDefault(); ACTIONS['rotate-ccw'](); }
      else if (e.shiftKey && k === 's') { e.preventDefault(); saveAs(); }
      else if (k === 'z') { e.preventDefault(); undo(); }
      else if (k === 'y') { e.preventDefault(); redo(); }
      else if (k === 's') { e.preventDefault(); exportPdf(); }
      else if (k === 'o') { e.preventDefault(); $('file-open').click(); }
      else if (k === 'p') { e.preventDefault(); printDoc(); }
      else if (k === 'f') { e.preventDefault(); $('search-input').focus(); }
      else if (k === 'h') { e.preventDefault(); ACTIONS['find-replace'](); }
      else if (k === 'k') { e.preventDefault(); openPrefs(); }
      else if (k === 'd') { e.preventDefault(); if (S.pdf) showProperties(); }
      else if (k === 'a') { e.preventDefault(); doSelectAll(); }
      else if (k === 'x') { e.preventDefault(); doCut(); }
      else if (k === 'c') { e.preventDefault(); doCopy(); }
      else if (k === 'v') { e.preventDefault(); doPaste(); }
      else if (e.key === '+' || e.key === '=') { e.preventDefault(); if (S.pdf) zoomIn(); }
      else if (e.key === '-') { e.preventDefault(); if (S.pdf) zoomOut(); }
      else if (e.key === '0') { e.preventDefault(); if (S.pdf) zoomFit(); }
      else if (e.key === '1') { e.preventDefault(); if (S.pdf) setZoom(1); }
      else if (e.key === '2') { e.preventDefault(); if (S.pdf) zoomFitWidth(); }
      return;
    }

    if (typing || anyModalOpen()) return;

    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        if (deleteSelected()) e.preventDefault();
        break;
      case 'ArrowLeft': case 'PageUp': gotoPage(S.page - 1); break;
      case 'ArrowRight': case 'PageDown': gotoPage(S.page + 1); break;
      case '+': case '=': if (S.pdf) zoomIn(); break;
      case '-': if (S.pdf) zoomOut(); break;
      case '0': if (S.pdf) zoomFit(); break;
      default: {
        const tools = {
          v: 'select', i: 'selecttext', h: 'hand', t: 'edittext', a: 'text',
          l: 'highlighter', d: 'pen', e: 'eraser',
          g: 'highlight', r: 'rect', o: 'ellipse', n: 'line', w: 'arrow',
        };
        const k = e.key.toLowerCase();
        if (k === 's') { ACTIONS['sign'](); break; }
        const tool = tools[k];
        if (tool) {
          if ((tool === 'edittext' || tool === 'selecttext') && !S.pdf) break;
          setTool(tool);
        }
      }
    }
  });

  /* ── Bus: rendering & document lifecycle ── */
  bus.on('rendered', () => {
    redrawOverlay();
    updateIndicators();
  });
  bus.on('doc', () => {
    $('page-wrap').hidden = false;
    $('dropzone').hidden = true;
    updateIndicators();
    updateDocInfo();
    const p = activePanel();
    if (p === 'marks') refreshBookmarks();
    if (p === 'files') refreshAttachments();
    if (p === 'notes') refreshNotes();
    if ($('panel-forms').open) scanForms();
  });
  bus.on('page', updateIndicators);
  bus.on('annots-changed', () => {
    if (activePanel() === 'notes') refreshNotes();
  });

  window.addEventListener('beforeunload', (e) => {
    if (S.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /* ── Initial paint ── */
  const about = $('about-version');
  if (about && CFG.version) about.textContent = 'Version ' + CFG.version + ' — the €1 PDF editor';
  syncPropsUi();
  reflectLicense();
  updateIndicators();
  syncToolButtons();
  applyToolCursor();
  setStatus('Ready');
}

/**
 * Orion editor — UI wiring: toolbars, modals, pro panels, thumbnails,
 * keyboard shortcuts, and the premium gate.
 */
'use strict';

import {
  S, bus, isPremium, undo, redo, canUndo, canRedo, resetHistory,
  annotsForCurrentPage,
} from './state.js';
import {
  loadNewDocument, reloadFromBytes,
  zoomIn, zoomOut, zoomFit, gotoPage,
} from './viewer.js';
import {
  redrawOverlay, applyToolCursor, addTextAnnotAt, updateTextAnnot,
  deleteSelected, clearSelection,
} from './annots.js';
import * as ops from './docops.js';

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

function openModal(id) {
  $(id).hidden = false;
}
function closeModals() {
  document.querySelectorAll('.modal-backdrop').forEach((m) => { m.hidden = true; });
}
function anyModalOpen() {
  return Array.from(document.querySelectorAll('.modal-backdrop')).some((m) => !m.hidden);
}

/** Premium gate: true if allowed, else opens the upgrade modal. */
function requirePremium(reason) {
  if (isPremium()) return true;
  $('up-reason').textContent = reason || 'This tool is part of Premium — one euro, everything unlocked.';
  $('up-error').hidden = true;
  openModal('modal-upgrade');
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

function updateIndicators() {
  $('page-indicator').textContent = S.pdf ? S.page + ' / ' + S.pageCount : '– / –';
  $('btn-zoom-fit').textContent = S.pdf ? Math.round(S.zoomScale * 100) + '%' : 'fit';
  $('file-name').textContent = S.fileName || 'No document';
}

function syncToolButtons() {
  document.querySelectorAll('#tool-buttons .tool-btn').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.tool === S.tool);
  });
}

function setTool(t) {
  if (t !== 'place') S.pendingImage = null;
  S.tool = t;
  applyToolCursor();
  syncToolButtons();
}

function reflectLicense() {
  const chip = $('license-chip');
  if (isPremium()) {
    chip.textContent = '✦ Premium';
    chip.classList.add('is-premium');
    document.querySelectorAll('.lock').forEach((el) => { el.hidden = true; });
    $('rail-upsell').classList.add('is-hidden');
  } else {
    chip.textContent = 'Free plan · Upgrade €1';
    chip.classList.remove('is-premium');
  }
}

/* ═══════════════════ Opening documents ═══════════════════ */

async function openPdfFile(file) {
  await run(async () => {
    const bytes = await fileToBytes(file);
    await loadNewDocument(bytes, file.name);
    resetHistory();
    S.dirty = false;
    S.selected = null;
    setTool('select');
    toast('Loaded ' + file.name);
  }, 'Could not open that PDF — it may be password-protected or corrupted.');
}

/* ═══════════════════ Images ═══════════════════ */

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

/* ═══════════════════ Signature pad ═══════════════════ */

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

/* ═══════════════════ Text modal ═══════════════════ */

let pendingText = null;

function openTextModal(mode, opts) {
  pendingText = Object.assign({ mode }, opts);
  if (mode === 'new') {
    $('tx-value').value = '';
    $('tx-size').value = S.fontSize;
    $('tx-color').value = S.color;
    $('tx-title').textContent = 'Text';
    $('tx-ok').textContent = 'Place text';
  } else {
    const a = annotsForCurrentPage()[opts.index];
    if (!a || a.type !== 'text') { pendingText = null; return; }
    $('tx-value').value = a.value;
    $('tx-size').value = a.size;
    $('tx-color').value = a.color;
    $('tx-title').textContent = 'Edit text';
    $('tx-ok').textContent = 'Save';
  }
  openModal('modal-text');
  $('tx-value').focus();
}

function commitTextModal() {
  if (!pendingText) { closeModals(); return; }
  const value = $('tx-value').value;
  const size = clamp(parseInt($('tx-size').value, 10) || 16, 6, 96);
  const color = $('tx-color').value;

  if (pendingText.mode === 'new') {
    addTextAnnotAt(pendingText.vx, pendingText.vy, value, size, color);
  } else {
    updateTextAnnot(pendingText.index, value, size);
    if (value.trim()) {
      const a = annotsForCurrentPage()[pendingText.index];
      if (a && a.type === 'text') { a.color = color; redrawOverlay(); }
    }
  }
  pendingText = null;
  closeModals();
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

/* ═══════════════════ Main init ═══════════════════ */

export function initUI() {
  /* ── Open / merge / drop ── */
  $('btn-open').addEventListener('click', () => $('file-open').click());
  $('btn-open-2').addEventListener('click', () => $('file-open').click());
  $('file-open').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) openPdfFile(file);
  });

  $('btn-merge').addEventListener('click', () => {
    if (!needDoc()) return;
    const limit = (CFG.limits || {}).freeMergeFiles;
    const max = typeof limit === 'number' ? limit : 1;
    if (!isPremium() && S.mergeCount >= max) {
      requirePremium('The free plan merges ' + max + ' extra file per document. Premium (€1) is unlimited.');
      return;
    }
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
  $('btn-undo').addEventListener('click', () => undo());
  $('btn-redo').addEventListener('click', () => redo());
  bus.on('history', () => {
    $('btn-undo').disabled = !canUndo();
    $('btn-redo').disabled = !canRedo();
  });
  bus.on('restored', () => {
    run(() => reloadFromBytes(S.bytes));
  });

  /* ── Zoom / navigation ── */
  $('btn-zoom-in').addEventListener('click', () => { if (S.pdf) zoomIn(); });
  $('btn-zoom-out').addEventListener('click', () => { if (S.pdf) zoomOut(); });
  $('btn-zoom-fit').addEventListener('click', () => { if (S.pdf) zoomFit(); });
  $('btn-prev').addEventListener('click', () => gotoPage(S.page - 1));
  $('btn-next').addEventListener('click', () => gotoPage(S.page + 1));

  /* ── Tools & properties ── */
  document.querySelectorAll('#tool-buttons .tool-btn').forEach((b) => {
    b.addEventListener('click', () => setTool(b.dataset.tool));
  });
  bus.on('tool', syncToolButtons);

  $('prop-color').addEventListener('input', (e) => { S.color = e.target.value; });
  $('prop-width').addEventListener('input', (e) => { S.strokeWidth = Number(e.target.value); });
  $('prop-size').addEventListener('change', (e) => {
    S.fontSize = clamp(parseInt(e.target.value, 10) || 16, 6, 96);
    e.target.value = S.fontSize;
  });

  /* ── Page structure ── */
  $('btn-rotate-l').addEventListener('click', () => {
    if (needDoc()) run(() => ops.rotatePage(S.page - 1, -90));
  });
  $('btn-rotate-r').addEventListener('click', () => {
    if (needDoc()) run(() => ops.rotatePage(S.page - 1, 90));
  });
  $('btn-delete-page').addEventListener('click', () => {
    if (!needDoc()) return;
    if (!window.confirm('Delete page ' + S.page + '?')) return;
    run(() => ops.deletePage(S.page - 1));
  });

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

  /* ── License / upgrade ── */
  $('license-chip').addEventListener('click', () => {
    if (isPremium()) { toast('✦ Premium is active on this device', 'is-gold'); return; }
    requirePremium('Premium unlocks every pro tool — for one euro.');
  });
  $('btn-upsell').addEventListener('click', () => {
    requirePremium('Premium unlocks every pro tool — for one euro.');
  });
  $('btn-buy-now').addEventListener('click', () => {
    const link = CFG.premiumPaymentLink;
    if (link) window.open(link, '_blank', 'noopener');
    else toast('No payment link configured yet — see the README. You can activate a key below.');
  });
  $('btn-activate-key').addEventListener('click', () => {
    const ok = window.OrionLicense && window.OrionLicense.activate($('up-key').value);
    if (ok) {
      closeModals();
      reflectLicense();
      toast('✦ Premium active — thank you!', 'is-gold');
    } else {
      $('up-error').hidden = false;
    }
  });
  $('up-key').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-activate-key').click();
  });

  /* ── Premium tools: sign & image ── */
  $('btn-sign').addEventListener('click', () => {
    if (!needDoc()) return;
    if (!requirePremium('Signatures are a Premium tool — €1 unlocks everything.')) return;
    clearPad();
    openModal('modal-sign');
  });
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

  /* ── Text modal ── */
  bus.on('text-annot-request', ({ vx, vy }) => openTextModal('new', { vx, vy }));
  bus.on('edit-text-annot', ({ index }) => openTextModal('edit', { index }));
  $('tx-ok').addEventListener('click', commitTextModal);
  $('tx-value').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) commitTextModal();
  });

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
      $('md-author').value = m.author;
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

  $('btn-optimize').addEventListener('click', () => {
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
      }
    });
  });

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

  $('btn-export-pdf').addEventListener('click', () => {
    if (!needDoc()) return;
    run(async () => {
      await ops.exportPdf({ badge: !isPremium() });
      toast(isPremium() ? '✦ Exported' : 'Exported — Premium (€1) removes the badge', 'is-gold');
    });
  });

  /* ── Modal close (delegated) ── */
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('js-close') || e.target.classList.contains('modal-backdrop')) {
      closeModals();
    }
  });

  /* ── Keyboard shortcuts ── */
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (anyModalOpen()) { closeModals(); return; }
      if (S.tool === 'place') { setTool('select'); return; }
      clearSelection();
      return;
    }

    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select'
      || e.target.isContentEditable;

    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if ((k === 'z' || k === 'y') && typing) return; // native undo in inputs
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
      else if (k === 's') { e.preventDefault(); $('btn-export-pdf').click(); }
      else if (k === 'o') { e.preventDefault(); $('file-open').click(); }
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
          v: 'select', t: 'text', p: 'pen', h: 'highlighter',
          r: 'rect', e: 'ellipse', l: 'line', a: 'arrow',
        };
        const tool = tools[e.key.toLowerCase()];
        if (tool) setTool(tool);
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
    if ($('panel-forms').open) scanForms();
  });
  bus.on('page', updateIndicators);

  window.addEventListener('beforeunload', (e) => {
    if (S.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /* ── Initial paint ── */
  reflectLicense();
  updateIndicators();
  syncToolButtons();
  applyToolCursor();
}

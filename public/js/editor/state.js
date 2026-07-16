/**
 * Orion editor — shared state, event bus, undo/redo history.
 *
 * Source of truth is `S.bytes` (the current PDF as a Uint8Array) plus
 * `S.annots` (un-burned annotations keyed by stable page id). Structural
 * operations always produce a NEW bytes array, so history can hold
 * references safely.
 */
'use strict';

export const S = {
  bytes: null,          // Uint8Array — current PDF
  fileName: '',
  pdf: null,            // pdf.js PDFDocumentProxy for S.bytes
  pageCount: 0,
  page: 1,              // current page, 1-based
  zoomMode: 'fit',      // 'fit' | 'manual'
  zoomScale: 1,         // effective scale actually used to render

  pageIds: [],          // stable id per page, parallel to current page order
  annots: {},           // pageId -> Annot[]

  tool: 'select',
  color: '#e8483f',
  strokeWidth: 3,
  fontSize: 16,
  selected: null,       // { pageId, index } | null
  pendingImage: null,   // { dataUrl, fmt, w, h, kind } while placing

  mergeCount: 0,        // extra files merged into this document (free limit)
  dirty: false,
};

/* ── Tiny event bus ─────────────────────────────────────────────── */
const listeners = {};
export const bus = {
  on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
  emit(evt, ...args) {
    (listeners[evt] || []).forEach((fn) => {
      try { fn(...args); } catch (e) { console.error(`[bus:${evt}]`, e); }
    });
  },
};

/* ── Premium ────────────────────────────────────────────────────── */
export function isPremium() {
  return !!(window.OrionLicense && window.OrionLicense.isPremium());
}

/* ── Page ids ───────────────────────────────────────────────────── */
let idCounter = 0;
export function newPageId() {
  idCounter += 1;
  return 'pg' + idCounter + '_' + Date.now().toString(36);
}

/* ── History ────────────────────────────────────────────────────── */
const MAX_HISTORY = 12;
let undoStack = [];
let redoStack = [];

function capture() {
  return {
    bytes: S.bytes,                       // immutable by convention
    pageIds: S.pageIds.slice(),
    annots: JSON.parse(JSON.stringify(S.annots)),
    page: S.page,
    mergeCount: S.mergeCount,
  };
}

function restore(snap) {
  S.bytes = snap.bytes;
  S.pageIds = snap.pageIds.slice();
  S.annots = JSON.parse(JSON.stringify(snap.annots));
  S.page = snap.page;
  S.mergeCount = snap.mergeCount;
  S.selected = null;
}

/** Call BEFORE mutating state. */
export function snapshot() {
  undoStack.push(capture());
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack = [];
  S.dirty = true;
  bus.emit('history');
}

export function undo() {
  if (!undoStack.length) return false;
  redoStack.push(capture());
  restore(undoStack.pop());
  bus.emit('history');
  bus.emit('restored');
  return true;
}

export function redo() {
  if (!redoStack.length) return false;
  undoStack.push(capture());
  restore(redoStack.pop());
  bus.emit('history');
  bus.emit('restored');
  return true;
}

export function canUndo() { return undoStack.length > 0; }
export function canRedo() { return redoStack.length > 0; }

export function resetHistory() {
  undoStack = [];
  redoStack = [];
  bus.emit('history');
}

/* ── Annotation helpers ─────────────────────────────────────────── */
export function currentPageId() {
  return S.pageIds[S.page - 1];
}

export function annotsForCurrentPage() {
  const id = currentPageId();
  if (!id) return [];
  if (!S.annots[id]) S.annots[id] = [];
  return S.annots[id];
}

export function annotCount() {
  return Object.values(S.annots).reduce((n, list) => n + list.length, 0);
}

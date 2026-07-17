/**
 * Orion editor — inline text layer: WYSIWYG editing directly on the page.
 *
 * One floating, draggable, contenteditable box (in #inline-layer, viewport
 * pixel space over the canvases) backs three flows:
 *   add        Add Text tool — a ghost box rides the cursor; a click anchors
 *              it and typing goes straight onto the page
 *   edit-annot double-click an existing text annotation to retype it in place
 *   edit-page  Edit Text tool — click a detected page-text block and retype
 *              it (committed through docops.coverAndRetype, correction-tape
 *              style); drag the dotted border to move the block
 *
 * The box anchor lives in PDF user space (baseline start), so zooming or
 * re-rendering repositions the box instead of breaking it. Committing is
 * page-safe: the target page is captured when editing starts.
 */
'use strict';

import { S, bus, snapshot } from './state.js';
import { toPdfPoint, toViewportPoint, getViewport } from './viewer.js';
import { redrawOverlay } from './annots.js';
import * as feat from './features.js';
import * as ops from './docops.js';

const $ = (id) => document.getElementById(id);

const FONT_STACKS = {
  Helvetica: 'Helvetica, Arial, sans-serif',
  TimesRoman: '"Times New Roman", Times, serif',
  Courier: '"Courier New", Courier, monospace',
};

let active = null;   // the open box (see makeBox) or null
let ghost = null;    // cursor-following preview for the Add Text tool
let armed = false;   // Add Text tool selected → ghost follows the pointer
let deps = {         // ui.js injects run/toast at init
  run: async (fn) => fn(),
  toast: () => {},
};

export function isEditing() {
  return !!active;
}

/* ── Geometry ── */

/** Screen-space angle (deg) of a user-space direction at a point. */
function screenAngleDeg(x, y, angleRad) {
  const p0 = toViewportPoint(x, y);
  const p1 = toViewportPoint(x + Math.cos(angleRad), y + Math.sin(angleRad));
  return (Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180) / Math.PI;
}

/** Re-derive the box's CSS from its user-space anchor + current viewport. */
function positionActive() {
  if (!active || !getViewport()) return;
  const scale = getViewport().scale;
  const fontPx = Math.max(8, active.size * scale);
  const p = toViewportPoint(active.anchor.x, active.anchor.y);
  const pad = 4; // border 1px + padding 3px
  active.el.style.left = (p.x - pad) + 'px';
  active.el.style.top = (p.y - fontPx * 1.05 - pad) + 'px';
  active.textEl.style.fontSize = fontPx + 'px';
  const deg = screenAngleDeg(active.anchor.x, active.anchor.y, active.angleRad);
  active.el.style.transformOrigin = pad + 'px ' + (fontPx * 1.05 + pad) + 'px';
  active.el.style.transform = Math.abs(deg) > 0.5 ? 'rotate(' + deg + 'deg)' : '';
}

/* ── Box lifecycle ── */

function makeBox(opts) {
  if (active) commitActive();
  const el = document.createElement('div');
  el.className = 'inline-box' + (opts.kind === 'edit-page' ? ' is-page' : '');
  const textEl = document.createElement('div');
  textEl.className = 'ib-text';
  textEl.contentEditable = 'true';
  textEl.spellcheck = false;
  textEl.style.fontFamily = FONT_STACKS[opts.fontFamily] || FONT_STACKS.Helvetica;
  textEl.style.color = opts.color;
  textEl.innerText = opts.text || '';
  el.appendChild(textEl);
  $('inline-layer').appendChild(el);

  active = {
    kind: opts.kind,
    el, textEl,
    anchor: { x: opts.anchor.x, y: opts.anchor.y },
    origin: { x: opts.anchor.x, y: opts.anchor.y },
    size: opts.size,
    color: opts.color,
    fontFamily: opts.fontFamily,
    angleRad: opts.angleRad || 0,
    multiline: !!opts.multiline,
    pageIdx: S.page - 1,
    pageId: S.pageIds[S.page - 1],
    line: opts.line || null,
    index: opts.index != null ? opts.index : null,
  };

  textEl.addEventListener('keydown', (e) => {
    e.stopPropagation(); // the box owns the keyboard; global shortcuts wait
    if (!active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelActive();
    } else if (e.key === 'Enter' && (!active.multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      commitActive();
    }
  });

  // Dragging the dotted border (the padding ring) repositions the block.
  el.addEventListener('pointerdown', (e) => {
    if (e.target !== el || e.button !== 0 || !active) return;
    e.preventDefault();
    const startView = toViewportPoint(active.anchor.x, active.anchor.y);
    const sx = e.clientX;
    const sy = e.clientY;
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
      if (!active) return;
      active.anchor = toPdfPoint(startView.x + (ev.clientX - sx), startView.y + (ev.clientY - sy));
      positionActive();
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  });

  positionActive();
  hideGhost();
  focusEnd(textEl);
  return active;
}

function focusEnd(el) {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function teardown() {
  const a = active;
  active = null;
  if (a) a.el.remove();
  if (S.hiddenAnnot) {
    S.hiddenAnnot = null;
  }
  return a;
}

export function cancelActive() {
  if (!active) return false;
  teardown();
  redrawOverlay();
  return true;
}

export function commitActive() {
  const a = teardown();
  if (!a) return false;
  const text = a.textEl.innerText.replace(/\u00a0/g, ' ').replace(/\n+$/, '');

  if (a.kind === 'add') {
    if (text.trim()) {
      snapshot();
      const list = S.annots[a.pageId] || (S.annots[a.pageId] = []);
      list.push({
        type: 'text', x: a.anchor.x, y: a.anchor.y,
        size: a.size, color: a.color, value: text,
        font: a.fontFamily, opacity: S.opacity,
      });
      bus.emit('annots-changed');
    }
  } else if (a.kind === 'edit-annot') {
    const list = S.annots[a.pageId] || [];
    const t = list[a.index];
    if (t && t.type === 'text') {
      const moved = Math.hypot(a.anchor.x - a.origin.x, a.anchor.y - a.origin.y) > 0.5;
      if (text !== t.value || moved) {
        snapshot();
        if (text.trim()) {
          t.value = text;
          t.x = a.anchor.x;
          t.y = a.anchor.y;
        } else {
          list.splice(a.index, 1);
          S.selected = null;
        }
        bus.emit('annots-changed');
      }
    }
  } else if (a.kind === 'edit-page') {
    const dx = a.anchor.x - a.origin.x;
    const dy = a.anchor.y - a.origin.y;
    const changed = text !== a.line.str || Math.hypot(dx, dy) > 0.5;
    if (changed) {
      deps.run(async () => {
        await ops.coverAndRetype(a.pageIdx, a.line, {
          text, size: a.size, colorHex: a.color, fontFamily: a.fontFamily, dx, dy,
        });
        deps.toast('Text updated', 'is-gold');
      }, 'Could not update the text');
    }
  }

  redrawOverlay();
  return true;
}

/* ── Entry points ── */

/** Add Text: anchor a new box with its baseline at the click point. */
export function beginAddText(vx, vy) {
  if (!S.pdf) return;
  makeBox({
    kind: 'add',
    anchor: toPdfPoint(vx, vy),
    size: S.fontSize,
    color: S.color,
    fontFamily: S.fontFamily,
    multiline: true,
  });
}

/** Edit Text: open the detected text block under the click for retyping. */
export async function beginEditPageText(vx, vy) {
  if (!S.pdf) return false;
  await feat.ensureLines(S.page);
  const hit = feat.lineAt(S.page, toPdfPoint(vx, vy), 14);
  if (!hit) return false;
  const ln = hit.line;
  makeBox({
    kind: 'edit-page',
    anchor: { x: ln.x, y: ln.y },
    size: ln.size,
    color: '#111111',
    fontFamily: S.fontFamily,
    angleRad: ln.angleRad,
    text: ln.str,
    line: ln,
  });
  return true;
}

/** Retype an existing text annotation in place (double-click, Select tool). */
export function beginEditAnnot(index) {
  const list = S.annots[S.pageIds[S.page - 1]] || [];
  const t = list[index];
  if (!t || t.type !== 'text') return;
  makeBox({
    kind: 'edit-annot',
    anchor: { x: t.x, y: t.y },
    size: t.size,
    color: t.color,
    fontFamily: t.font || 'Helvetica',
    text: t.value,
    multiline: true,
    index,
  });
  S.hiddenAnnot = { pageId: active.pageId, index }; // hide the canvas copy
  redrawOverlay();
}

/* ── Add Text ghost (box attached to the cursor until anchored) ── */

function showGhost(vx, vy) {
  if (!ghost) {
    ghost = document.createElement('div');
    ghost.className = 'inline-ghost';
    ghost.textContent = 'Type here…';
    $('inline-layer').appendChild(ghost);
  }
  const scale = getViewport() ? getViewport().scale : 1;
  const fontPx = Math.max(8, S.fontSize * scale);
  ghost.style.fontSize = fontPx + 'px';
  ghost.style.left = (vx - 4) + 'px';
  ghost.style.top = (vy - fontPx * 1.05 - 4) + 'px';
  ghost.hidden = false;
}

function hideGhost() {
  if (ghost) ghost.hidden = true;
}

/** Called by ui.setTool — arms the ghost for 'text', commits open edits. */
export function onToolChange(tool) {
  if (active) commitActive();
  armed = tool === 'text';
  if (!armed) hideGhost();
}

/* ── Wiring ── */

export function initInline(injected) {
  deps = Object.assign(deps, injected || {});

  const stage = $('stage');
  stage.addEventListener('pointermove', (e) => {
    if (!armed || active || !S.pdf || !getViewport()) { hideGhost(); return; }
    const r = $('overlay-canvas').getBoundingClientRect();
    const vx = e.clientX - r.left;
    const vy = e.clientY - r.top;
    if (vx < 0 || vy < 0 || vx > r.width || vy > r.height) { hideGhost(); return; }
    showGhost(vx, vy);
  });
  stage.addEventListener('pointerleave', hideGhost);

  // A press anywhere outside the box commits it. Presses on the overlay with
  // a text tool active are left to the tool handlers (they commit + swallow,
  // so the same click doesn't immediately spawn or edit another box).
  document.addEventListener('pointerdown', (e) => {
    if (!active || active.el.contains(e.target)) return;
    if (e.target === $('overlay-canvas') && (S.tool === 'text' || S.tool === 'edittext')) return;
    commitActive();
  }, true);

  bus.on('rendered', positionActive);      // zoom / re-render keeps the box glued
  bus.on('page', () => { if (active) commitActive(); });
  bus.on('doc', () => { if (active) cancelActive(); }); // bytes changed underneath
  bus.on('restored', () => { if (active) cancelActive(); }); // undo/redo — indices are stale
}

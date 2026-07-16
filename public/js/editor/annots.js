/**
 * Orion editor — annotation layer.
 *
 * All annotation geometry is stored in PDF user space (points, y-up),
 * converted through the live pdf.js viewport for display and interaction.
 * Types:
 *   text      { x, y, size, color, value }            (x,y = baseline left)
 *   ink       { points:[[x,y]…], width, color, alpha }
 *   rect      { x1,y1,x2,y2, width, color }
 *   highlight { x1,y1,x2,y2, color }                  (filled, α .35)
 *   ellipse   { x1,y1,x2,y2, width, color }
 *   line      { x1,y1,x2,y2, width, color }
 *   arrow     { x1,y1,x2,y2, width, color }
 *   image     { x1,y1,x2,y2, dataUrl, fmt, kind }     (kind: 'image'|'signature')
 */
'use strict';

import { S, bus, snapshot, currentPageId, annotsForCurrentPage } from './state.js';
import { toPdfPoint, toViewportPoint, getViewport } from './viewer.js';

const overlay = () => document.getElementById('overlay-canvas');

const imageCache = new Map(); // dataUrl -> HTMLImageElement

/* ═══════════════════ Drawing ═══════════════════ */

export function redrawOverlay(extra) {
  const cv = overlay();
  const vp = getViewport();
  if (!cv || !vp) return;
  const dpr = cv.width / Math.max(1, parseFloat(cv.style.width) || cv.width);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);

  const list = annotsForCurrentPage();
  for (let i = 0; i < list.length; i++) {
    drawAnnot(ctx, list[i]);
  }

  // Selection outline
  if (S.selected && S.selected.pageId === currentPageId()) {
    const a = list[S.selected.index];
    if (a) {
      const bb = annotBBox(ctx, a);
      ctx.save();
      ctx.strokeStyle = '#f0b34e';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(bb.x - 6, bb.y - 6, bb.w + 12, bb.h + 12);
      ctx.restore();
    }
  }

  if (typeof extra === 'function') extra(ctx);
}

function vpt(x, y) { return toViewportPoint(x, y); }

function drawAnnot(ctx, a) {
  const scale = getViewport().scale;
  ctx.save();
  switch (a.type) {
    case 'text': {
      const p = vpt(a.x, a.y);
      ctx.font = `${a.size * scale}px Helvetica, Arial, sans-serif`;
      ctx.fillStyle = a.color;
      ctx.textBaseline = 'alphabetic';
      const lines = String(a.value).split('\n');
      lines.forEach((line, i) => {
        ctx.fillText(line, p.x, p.y + i * a.size * 1.25 * scale);
      });
      break;
    }
    case 'ink': {
      if (a.points.length < 2) break;
      ctx.globalAlpha = a.alpha != null ? a.alpha : 1;
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.width * scale;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const p0 = vpt(a.points[0][0], a.points[0][1]);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < a.points.length; i++) {
        const p = vpt(a.points[i][0], a.points[i][1]);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
      break;
    }
    case 'highlight': {
      const r = vpRect(a);
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = a.color;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      break;
    }
    case 'rect': {
      const r = vpRect(a);
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.width * scale;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      break;
    }
    case 'ellipse': {
      const r = vpRect(a);
      ctx.strokeStyle = a.color;
      ctx.lineWidth = a.width * scale;
      ctx.beginPath();
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'line':
    case 'arrow': {
      const p1 = vpt(a.x1, a.y1);
      const p2 = vpt(a.x2, a.y2);
      ctx.strokeStyle = a.color;
      ctx.fillStyle = a.color;
      ctx.lineWidth = a.width * scale;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
      if (a.type === 'arrow') {
        const ang = Math.atan2(p2.y - p1.y, p2.x - p1.x);
        const len = Math.max(9, a.width * scale * 3.4);
        ctx.beginPath();
        ctx.moveTo(p2.x, p2.y);
        ctx.lineTo(p2.x - len * Math.cos(ang - 0.42), p2.y - len * Math.sin(ang - 0.42));
        ctx.lineTo(p2.x - len * Math.cos(ang + 0.42), p2.y - len * Math.sin(ang + 0.42));
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case 'image': {
      const r = vpRect(a);
      const img = getImage(a.dataUrl);
      if (img && img.complete && img.naturalWidth) {
        ctx.drawImage(img, r.x, r.y, r.w, r.h);
      } else {
        ctx.strokeStyle = 'rgba(240,179,78,.8)';
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(r.x, r.y, r.w, r.h);
      }
      break;
    }
  }
  ctx.restore();
}

/** Viewport-space rect from user-space corners. */
function vpRect(a) {
  const p1 = vpt(a.x1, a.y1);
  const p2 = vpt(a.x2, a.y2);
  return {
    x: Math.min(p1.x, p2.x),
    y: Math.min(p1.y, p2.y),
    w: Math.abs(p2.x - p1.x),
    h: Math.abs(p2.y - p1.y),
  };
}

function getImage(dataUrl) {
  if (!imageCache.has(dataUrl)) {
    const img = new Image();
    img.onload = () => redrawOverlay();
    img.src = dataUrl;
    imageCache.set(dataUrl, img);
  }
  return imageCache.get(dataUrl);
}

/** Viewport-space bounding box of an annotation. */
function annotBBox(ctx, a) {
  const scale = getViewport().scale;
  if (a.type === 'text') {
    const p = vpt(a.x, a.y);
    ctx.font = `${a.size * scale}px Helvetica, Arial, sans-serif`;
    const lines = String(a.value).split('\n');
    let w = 0;
    lines.forEach((l) => { w = Math.max(w, ctx.measureText(l).width); });
    const lh = a.size * 1.25 * scale;
    return { x: p.x, y: p.y - a.size * scale, w, h: lh * (lines.length - 1) + a.size * scale * 1.2 };
  }
  if (a.type === 'ink') {
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    a.points.forEach(([x, y]) => {
      const p = vpt(x, y);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    });
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  const r = vpRect(a);
  return { x: r.x, y: r.y, w: r.w, h: r.h };
}

/* ═══════════════════ Interaction ═══════════════════ */

let drag = null; // in-progress gesture

const CURSORS = {
  select: 'default', text: 'text', pen: 'crosshair', highlighter: 'crosshair',
  rect: 'crosshair', highlight: 'crosshair', ellipse: 'crosshair',
  line: 'crosshair', arrow: 'crosshair', place: 'copy',
};

export function applyToolCursor() {
  const cv = overlay();
  if (cv) cv.style.cursor = CURSORS[S.tool] || 'default';
}

function pos(e) {
  const rect = overlay().getBoundingClientRect();
  return { vx: e.clientX - rect.left, vy: e.clientY - rect.top };
}

export function initAnnotEvents() {
  const cv = overlay();

  cv.addEventListener('pointerdown', (e) => {
    if (!S.pdf || e.button !== 0) return;
    cv.setPointerCapture(e.pointerId);
    const { vx, vy } = pos(e);

    switch (S.tool) {
      case 'text':
        bus.emit('text-annot-request', { vx, vy });
        break;

      case 'pen':
      case 'highlighter':
        drag = { kind: 'ink', pts: [[vx, vy]] };
        break;

      case 'rect':
      case 'highlight':
      case 'ellipse':
      case 'line':
      case 'arrow':
        drag = { kind: 'shape', shape: S.tool, x0: vx, y0: vy, x1: vx, y1: vy };
        break;

      case 'place':
        if (S.pendingImage) drag = { kind: 'place', x0: vx, y0: vy, x1: vx, y1: vy };
        break;

      case 'select':
      default: {
        const hit = hitTest(vx, vy);
        if (hit) {
          S.selected = { pageId: currentPageId(), index: hit.index };
          const a = annotsForCurrentPage()[hit.index];
          drag = {
            kind: 'move', startVx: vx, startVy: vy,
            original: JSON.parse(JSON.stringify(a)),
            moved: false,
          };
        } else {
          S.selected = null;
        }
        redrawOverlay();
        bus.emit('selection');
        break;
      }
    }
  });

  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const { vx, vy } = pos(e);

    if (drag.kind === 'ink') {
      const last = drag.pts[drag.pts.length - 1];
      if (Math.hypot(vx - last[0], vy - last[1]) > 1.5) drag.pts.push([vx, vy]);
      redrawOverlay((ctx) => {
        const scale = getViewport().scale;
        const hl = S.tool === 'highlighter';
        ctx.save();
        ctx.globalAlpha = hl ? 0.35 : 1;
        ctx.strokeStyle = S.color;
        ctx.lineWidth = (hl ? S.strokeWidth * 4 : S.strokeWidth) * scale;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(drag.pts[0][0], drag.pts[0][1]);
        for (let i = 1; i < drag.pts.length; i++) ctx.lineTo(drag.pts[i][0], drag.pts[i][1]);
        ctx.stroke();
        ctx.restore();
      });
    } else if (drag.kind === 'shape' || drag.kind === 'place') {
      drag.x1 = vx; drag.y1 = vy;
      redrawOverlay((ctx) => drawGesturePreview(ctx, drag));
    } else if (drag.kind === 'move') {
      if (!drag.moved) {
        if (Math.hypot(vx - drag.startVx, vy - drag.startVy) < 3) return;
        snapshot();
        drag.moved = true;
      }
      const from = toPdfPoint(drag.startVx, drag.startVy);
      const to = toPdfPoint(vx, vy);
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const a = annotsForCurrentPage()[S.selected.index];
      applyOffset(a, drag.original, dx, dy);
      redrawOverlay();
    }
  });

  cv.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    const { vx, vy } = pos(e);

    if (d.kind === 'ink') {
      if (d.pts.length > 1) {
        const hl = S.tool === 'highlighter';
        snapshot();
        annotsForCurrentPage().push({
          type: 'ink',
          points: d.pts.map(([x, y]) => {
            const p = toPdfPoint(x, y);
            return [p.x, p.y];
          }),
          width: hl ? S.strokeWidth * 4 : S.strokeWidth,
          color: S.color,
          alpha: hl ? 0.35 : 1,
        });
        bus.emit('annots-changed');
      }
      redrawOverlay();
    } else if (d.kind === 'shape') {
      if (Math.hypot(vx - d.x0, vy - d.y0) > 4) {
        const p1 = toPdfPoint(d.x0, d.y0);
        const p2 = toPdfPoint(vx, vy);
        snapshot();
        const base = { color: S.color, width: S.strokeWidth };
        if (d.shape === 'line' || d.shape === 'arrow') {
          annotsForCurrentPage().push({ type: d.shape, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, ...base });
        } else {
          annotsForCurrentPage().push({ type: d.shape, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, ...base });
        }
        bus.emit('annots-changed');
      }
      redrawOverlay();
    } else if (d.kind === 'place') {
      placePendingImage(d, vx, vy);
    } else if (d.kind === 'move' && d.moved) {
      bus.emit('annots-changed');
    }
  });

  cv.addEventListener('dblclick', (e) => {
    if (S.tool !== 'select') return;
    const { vx, vy } = pos(e);
    const hit = hitTest(vx, vy);
    if (hit) {
      const a = annotsForCurrentPage()[hit.index];
      if (a.type === 'text') bus.emit('edit-text-annot', { index: hit.index });
    }
  });
}

function drawGesturePreview(ctx, d) {
  const scale = getViewport().scale;
  ctx.save();
  ctx.strokeStyle = S.color;
  ctx.fillStyle = S.color;
  ctx.lineWidth = S.strokeWidth * scale;
  const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
  const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);

  if (d.kind === 'place') {
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = '#f0b34e';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
    return;
  }
  switch (d.shape) {
    case 'highlight':
      ctx.globalAlpha = 0.35;
      ctx.fillRect(x, y, w, h);
      break;
    case 'rect':
      ctx.strokeRect(x, y, w, h);
      break;
    case 'ellipse':
      ctx.beginPath();
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    case 'line':
    case 'arrow':
      ctx.beginPath();
      ctx.moveTo(d.x0, d.y0);
      ctx.lineTo(d.x1, d.y1);
      ctx.stroke();
      break;
  }
  ctx.restore();
}

function placePendingImage(d, vx, vy) {
  const img = S.pendingImage;
  if (!img) return;
  const dragged = Math.hypot(vx - d.x0, vy - d.y0) > 8;

  let x0 = d.x0, y0 = d.y0, x1 = vx, y1 = vy;
  if (!dragged) {
    // Simple click: place at a sensible default size, centered on click.
    const w = 180;
    const h = w * (img.h / img.w || 0.5);
    x0 = d.x0 - w / 2; y0 = d.y0 - h / 2;
    x1 = d.x0 + w / 2; y1 = d.y0 + h / 2;
  }
  const p1 = toPdfPoint(Math.min(x0, x1), Math.min(y0, y1));
  const p2 = toPdfPoint(Math.max(x0, x1), Math.max(y0, y1));
  snapshot();
  annotsForCurrentPage().push({
    type: 'image',
    x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y,
    dataUrl: img.dataUrl, fmt: img.fmt, kind: img.kind || 'image',
  });
  S.pendingImage = null;
  S.tool = 'select';
  applyToolCursor();
  bus.emit('annots-changed');
  bus.emit('tool');
  redrawOverlay();
}

function applyOffset(a, orig, dx, dy) {
  if (!a) return;
  if (a.type === 'text') {
    a.x = orig.x + dx; a.y = orig.y + dy;
  } else if (a.type === 'ink') {
    a.points = orig.points.map(([x, y]) => [x + dx, y + dy]);
  } else {
    a.x1 = orig.x1 + dx; a.y1 = orig.y1 + dy;
    a.x2 = orig.x2 + dx; a.y2 = orig.y2 + dy;
  }
}

function hitTest(vx, vy) {
  const cv = overlay();
  const ctx = cv.getContext('2d');
  const list = annotsForCurrentPage();
  for (let i = list.length - 1; i >= 0; i--) {
    const bb = annotBBox(ctx, list[i]);
    if (vx >= bb.x - 6 && vx <= bb.x + bb.w + 6 && vy >= bb.y - 6 && vy <= bb.y + bb.h + 6) {
      return { index: i };
    }
  }
  return null;
}

/* ═══════════════════ Public ops ═══════════════════ */

export function addTextAnnotAt(vx, vy, value, size, color) {
  if (!value || !value.trim()) return;
  const p = toPdfPoint(vx, vy);
  snapshot();
  annotsForCurrentPage().push({
    type: 'text', x: p.x, y: p.y,
    size: size || S.fontSize, color: color || S.color, value: value,
  });
  bus.emit('annots-changed');
  redrawOverlay();
}

export function updateTextAnnot(index, value, size) {
  const list = annotsForCurrentPage();
  const a = list[index];
  if (!a || a.type !== 'text') return;
  snapshot();
  if (value && value.trim()) {
    a.value = value;
    if (size) a.size = size;
  } else {
    list.splice(index, 1);
    S.selected = null;
  }
  bus.emit('annots-changed');
  redrawOverlay();
}

export function deleteSelected() {
  if (!S.selected) return false;
  const list = S.annots[S.selected.pageId];
  if (!list || !list[S.selected.index]) return false;
  snapshot();
  list.splice(S.selected.index, 1);
  S.selected = null;
  bus.emit('annots-changed');
  bus.emit('selection');
  redrawOverlay();
  return true;
}

export function clearSelection() {
  S.selected = null;
  redrawOverlay();
  bus.emit('selection');
}

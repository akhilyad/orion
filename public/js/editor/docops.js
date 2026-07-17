/**
 * Orion editor — document operations via pdf-lib.
 *
 * Structural ops (rotate/delete/reorder/merge) follow one pattern:
 *   snapshot() → mutate a pdf-lib copy of S.bytes → save() → reloadFromBytes().
 *
 * Export burns annotations into the PDF. Annotation geometry is stored in
 * PDF user space; for page-rotation-aware text/image orientation we derive
 * the screen axes from a scale-1 pdf.js viewport of the SAME bytes, so the
 * burn-in math is guaranteed consistent with what the user saw.
 */
'use strict';

import { S, bus, snapshot, newPageId } from './state.js';
import { reloadFromBytes } from './viewer.js';

const { PDFDocument, StandardFonts, rgb, degrees, LineCapStyle } = window.PDFLib;

/* ── Helpers ────────────────────────────────────────────────────── */

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const n = m ? parseInt(m[1], 16) : 0xe8483f;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function normDeg(a) {
  return ((Math.round(a / 90) * 90) % 360 + 360) % 360;
}

export function download(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function baseName() {
  return (S.fileName || 'document.pdf').replace(/\.pdf$/i, '');
}

/** Parse "1-3,5,9-12" into 0-based unique indices, validated against max. */
export function parseRange(str, max) {
  const out = [];
  const seen = new Set();
  const tokens = String(str || '').split(',');
  for (const raw of tokens) {
    const t = raw.trim();
    if (!t) continue;
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(t);
    if (!m) throw new Error(`Bad range: “${t}”`);
    let a = parseInt(m[1], 10);
    let b = m[2] ? parseInt(m[2], 10) : a;
    if (a > b) [a, b] = [b, a];
    if (a < 1 || b > max) throw new Error(`Pages must be between 1 and ${max}`);
    for (let i = a; i <= b; i++) {
      if (!seen.has(i)) { seen.add(i); out.push(i - 1); }
    }
  }
  if (!out.length) throw new Error('No pages selected');
  return out;
}

async function loadWorkingDoc() {
  return PDFDocument.load(S.bytes);
}

const FONT_KEYS = {
  Helvetica: 'Helvetica',
  TimesRoman: 'TimesRoman',
  Courier: 'Courier',
};

/** Lazily embed standard fonts per family for one working doc. */
function makeFontPool(doc) {
  const pool = new Map();
  return async function getFont(family) {
    const key = FONT_KEYS[family] || 'Helvetica';
    if (!pool.has(key)) {
      pool.set(key, await doc.embedFont(StandardFonts[key]));
    }
    return pool.get(key);
  };
}

/**
 * Screen-axis geometry for page i (0-based) at scale 1, derived from pdf.js.
 * dir = user-space vector of "screen right", e = "screen down",
 * angleDeg = CCW angle of dir (used as pdf-lib rotate for upright text).
 */
async function pageGeom(i) {
  const jsPage = await S.pdf.getPage(i + 1);
  const vp = jsPage.getViewport({ scale: 1 });
  const o = vp.convertToPdfPoint(0, 0);
  const px = vp.convertToPdfPoint(1, 0);
  const py = vp.convertToPdfPoint(0, 1);
  const dir = { x: px[0] - o[0], y: px[1] - o[1] };
  const e = { x: py[0] - o[0], y: py[1] - o[1] };
  return {
    vp,
    vw: vp.width,
    vh: vp.height,
    dir,
    e,
    angleDeg: (Math.atan2(dir.y, dir.x) * 180) / Math.PI,
    toPdf: (x, y) => {
      const p = vp.convertToPdfPoint(x, y);
      return { x: p[0], y: p[1] };
    },
    toView: (x, y) => {
      const p = vp.convertToViewportPoint(x, y);
      return { x: p[0], y: p[1] };
    },
  };
}

/* ═══════════════ Structural operations ═══════════════ */

export async function rotatePage(pageIdx, delta) {
  snapshot();
  const doc = await loadWorkingDoc();
  const page = doc.getPage(pageIdx);
  page.setRotation(degrees(normDeg(page.getRotation().angle + delta)));
  await reloadFromBytes(await doc.save());
}

export async function deletePage(pageIdx) {
  if (S.pageCount <= 1) throw new Error('A PDF needs at least one page.');
  snapshot();
  const doc = await loadWorkingDoc();
  doc.removePage(pageIdx);

  const [removedId] = S.pageIds.splice(pageIdx, 1);
  delete S.annots[removedId];
  if (pageIdx < S.page - 1) S.page -= 1;

  await reloadFromBytes(await doc.save());
}

export async function movePage(from, to) {
  if (from === to) return;
  snapshot();
  const doc = await loadWorkingDoc();
  const page = doc.getPage(from);
  doc.removePage(from);
  doc.insertPage(to, page);

  const currentId = S.pageIds[S.page - 1];
  const [movedId] = S.pageIds.splice(from, 1);
  S.pageIds.splice(to, 0, movedId);
  S.page = S.pageIds.indexOf(currentId) + 1;

  await reloadFromBytes(await doc.save());
}

export async function duplicatePage(pageIdx) {
  snapshot();
  const doc = await loadWorkingDoc();
  const [copy] = await doc.copyPages(doc, [pageIdx]);
  doc.insertPage(pageIdx + 1, copy);

  const srcId = S.pageIds[pageIdx];
  const newId = newPageId();
  S.pageIds.splice(pageIdx + 1, 0, newId);
  if (S.annots[srcId]) S.annots[newId] = JSON.parse(JSON.stringify(S.annots[srcId]));
  if (pageIdx + 1 < S.page) S.page += 1;

  await reloadFromBytes(await doc.save());
}

/** Insert a blank page before or after pageIdx, matching that page's size. */
export async function insertBlankPage(pageIdx, where) {
  snapshot();
  const doc = await loadWorkingDoc();
  const ref = doc.getPage(pageIdx);
  const { width, height } = ref.getSize();
  const at = where === 'after' ? pageIdx + 1 : pageIdx;
  doc.insertPage(at, [width, height]);

  S.pageIds.splice(at, 0, newPageId());
  if (at < S.page) S.page += 1;

  await reloadFromBytes(await doc.save());
}

export async function mergeBytes(otherBytes, otherName) {
  snapshot();
  const doc = await loadWorkingDoc();
  const other = await PDFDocument.load(otherBytes);
  const copied = await doc.copyPages(other, other.getPageIndices());
  copied.forEach((p) => {
    doc.addPage(p);
    S.pageIds.push(newPageId());
  });
  S.mergeCount += 1;
  await reloadFromBytes(await doc.save());
  return copied.length;
}

/* ═══════════════ Premium apply-operations ═══════════════ */

export async function addWatermark(text, { colorHex = '#8a8a8a', opacity = 0.15 } = {}) {
  snapshot();
  const doc = await loadWorkingDoc();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const color = hexToRgb(colorHex);
  const pages = doc.getPages();

  for (let i = 0; i < pages.length; i++) {
    const g = await pageGeom(i);
    // Screen-space up-right diagonal, expressed in user space.
    const u = {
      x: 0.7071 * g.dir.x - 0.7071 * g.e.x,
      y: 0.7071 * g.dir.y - 0.7071 * g.e.y,
    };
    const angle = (Math.atan2(u.y, u.x) * 180) / Math.PI;
    const diag = Math.hypot(g.vw, g.vh);
    const per100 = font.widthOfTextAtSize(text, 100);
    const size = Math.max(12, Math.min(160, (0.62 * diag * 100) / per100));
    const tw = font.widthOfTextAtSize(text, size);

    const c = g.toPdf(g.vw / 2, g.vh / 2);
    const anchor = {
      x: c.x - (u.x * tw) / 2 + 0.35 * size * u.y,
      y: c.y - (u.y * tw) / 2 - 0.35 * size * u.x,
    };
    pages[i].drawText(text, {
      x: anchor.x, y: anchor.y, size, font, color,
      opacity, rotate: degrees(angle),
    });
  }
  await reloadFromBytes(await doc.save());
}

export async function addPageNumbers({ format = '{n} / {total}', size = 10 } = {}) {
  snapshot();
  const doc = await loadWorkingDoc();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const color = rgb(0.42, 0.42, 0.42);
  const pages = doc.getPages();

  for (let i = 0; i < pages.length; i++) {
    const g = await pageGeom(i);
    const label = format.replace('{n}', String(i + 1)).replace('{total}', String(pages.length));
    const tw = font.widthOfTextAtSize(label, size);
    const p = g.toPdf(g.vw / 2, g.vh - 16);
    pages[i].drawText(label, {
      x: p.x - (g.dir.x * tw) / 2,
      y: p.y - (g.dir.y * tw) / 2,
      size, font, color, rotate: degrees(g.angleDeg),
    });
  }
  await reloadFromBytes(await doc.save());
}

/**
 * "Edit text": paint over a run of original page text and type the
 * replacement on top, matching the original baseline, size and angle.
 * item = { x, y (baseline, user space), width, size, angleRad }
 * dx/dy move the retyped text away from the original spot (inline drag);
 * the cover rectangle always stays on the original.
 */
export async function coverAndRetype(pageIdx, item, { text, size, colorHex, fontFamily, dx = 0, dy = 0 } = {}) {
  snapshot();
  const doc = await loadWorkingDoc();
  const page = doc.getPage(pageIdx);
  const getFont = makeFontPool(doc);
  const font = await getFont(fontFamily || 'Helvetica');

  const th = item.size;
  const drawSize = size || th;
  const angleDeg = (item.angleRad * 180) / Math.PI;
  const u = { x: Math.cos(item.angleRad), y: Math.sin(item.angleRad) }; // along text
  const v = { x: -u.y, y: u.x };                                       // text "up"

  const moved = Math.hypot(dx, dy) > 0.5;
  const newW = text ? font.widthOfTextAtSize(text, drawSize) : 0;
  const pad = 2;
  // When the text stays put, the cover must also hide any overhang of the
  // new (possibly longer) text; when moved, only the original needs hiding.
  const coverW = (moved ? item.width : Math.max(item.width, newW)) + pad * 2;
  const coverH = th * 1.42;
  // Rect origin: back up along the baseline and drop below the descender.
  const ox = item.x - pad * u.x - 0.28 * th * v.x;
  const oy = item.y - pad * u.y - 0.28 * th * v.y;

  page.drawRectangle({
    x: ox, y: oy, width: coverW, height: coverH,
    color: rgb(1, 1, 1), rotate: degrees(angleDeg),
  });
  if (text) {
    page.drawText(text, {
      x: item.x + dx, y: item.y + dy, size: drawSize, font,
      color: hexToRgb(colorHex || '#111111'),
      rotate: degrees(angleDeg),
    });
  }
  await reloadFromBytes(await doc.save());
}

export async function getMetadata() {
  const doc = await loadWorkingDoc();
  return {
    title: doc.getTitle() || '',
    author: doc.getAuthor() || '',
    subject: doc.getSubject() || '',
    keywords: doc.getKeywords() || '',
  };
}

export async function setMetadata({ title, author, subject, keywords }) {
  snapshot();
  const doc = await loadWorkingDoc();
  doc.setTitle(title || '');
  doc.setAuthor(author || '');
  doc.setSubject(subject || '');
  doc.setKeywords(keywords ? keywords.split(',').map((k) => k.trim()).filter(Boolean) : []);
  doc.setProducer('Orion PDF Editor');
  await reloadFromBytes(await doc.save());
}

export async function optimize() {
  const before = S.bytes.length;
  const doc = await loadWorkingDoc();
  const out = await doc.save({ useObjectStreams: true });
  if (out.length >= before) {
    return { before, after: before, applied: false };
  }
  snapshot();
  await reloadFromBytes(out);
  return { before, after: out.length, applied: true };
}

/* ═══════════════ Forms ═══════════════ */

export async function listFormFields() {
  const doc = await loadWorkingDoc();
  let fields;
  try {
    fields = doc.getForm().getFields();
  } catch (e) {
    return [];
  }
  return fields.map((f) => {
    const name = f.getName();
    const ctor = f.constructor.name;
    if (ctor === 'PDFTextField') {
      return { name, kind: 'text', value: f.getText() || '' };
    }
    if (ctor === 'PDFCheckBox') {
      return { name, kind: 'checkbox', value: f.isChecked() };
    }
    if (ctor === 'PDFDropdown') {
      return { name, kind: 'dropdown', value: (f.getSelected() || [])[0] || '', options: f.getOptions() };
    }
    if (ctor === 'PDFRadioGroup') {
      return { name, kind: 'radio', value: f.getSelected() || '', options: f.getOptions() };
    }
    return { name, kind: 'other' };
  });
}

export async function applyFormValues(values) {
  snapshot();
  const doc = await loadWorkingDoc();
  const form = doc.getForm();
  for (const v of values) {
    try {
      if (v.kind === 'text') form.getTextField(v.name).setText(v.value || '');
      else if (v.kind === 'checkbox') {
        const cb = form.getCheckBox(v.name);
        if (v.value) cb.check(); else cb.uncheck();
      } else if (v.kind === 'dropdown' && v.value) form.getDropdown(v.name).select(v.value);
      else if (v.kind === 'radio' && v.value) form.getRadioGroup(v.name).select(v.value);
    } catch (e) {
      console.warn('form field skipped:', v.name, e);
    }
  }
  await reloadFromBytes(await doc.save());
}

/* ═══════════════ Export (burn-in) ═══════════════ */

async function embedImageCached(doc, cache, a) {
  if (cache.has(a.dataUrl)) return cache.get(a.dataUrl);
  const b64 = a.dataUrl.split(',')[1];
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const img = a.dataUrl.startsWith('data:image/png')
    ? await doc.embedPng(bytes)
    : await doc.embedJpg(bytes);
  cache.set(a.dataUrl, img);
  return img;
}

async function burnAnnotations(doc, { badge }) {
  const getFont = makeFontPool(doc);
  const baseFont = await getFont('Helvetica');
  const cache = new Map();
  const pages = doc.getPages();

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const g = await pageGeom(i);
    const list = S.annots[S.pageIds[i]] || [];

    for (const a of list) {
      await burnOne(page, doc, a, getFont, g, cache);
    }

    if (badge) {
      const label = 'Made with OrionPDF · the €1 PDF editor';
      const p = g.toPdf(10, g.vh - 7);
      page.drawText(label, {
        x: p.x, y: p.y, size: 7, font: baseFont,
        color: rgb(0.55, 0.55, 0.55), opacity: 0.75,
        rotate: degrees(g.angleDeg),
      });
    }
  }
}

async function burnOne(page, doc, a, getFont, g, cache) {
  const color = hexToRgb(a.color);
  const alpha = a.opacity != null ? a.opacity : 1;

  switch (a.type) {
    case 'text': {
      const font = await getFont(a.font);
      const lines = String(a.value).split('\n');
      const lh = a.size * 1.25;
      lines.forEach((line, idx) => {
        page.drawText(line, {
          x: a.x + g.e.x * lh * idx,
          y: a.y + g.e.y * lh * idx,
          size: a.size, font, color, opacity: alpha,
          rotate: degrees(g.angleDeg),
        });
      });
      break;
    }
    case 'ink': {
      for (let i = 1; i < a.points.length; i++) {
        page.drawLine({
          start: { x: a.points[i - 1][0], y: a.points[i - 1][1] },
          end: { x: a.points[i][0], y: a.points[i][1] },
          thickness: a.width,
          color,
          opacity: a.alpha != null ? a.alpha : 1,
          lineCap: LineCapStyle.Round,
        });
      }
      break;
    }
    case 'highlight': {
      const r = userRect(a);
      page.drawRectangle({
        x: r.x, y: r.y, width: r.w, height: r.h,
        color, opacity: 0.35 * alpha,
      });
      break;
    }
    case 'rect': {
      const r = userRect(a);
      page.drawRectangle({
        x: r.x, y: r.y, width: r.w, height: r.h,
        borderColor: color, borderWidth: a.width, borderOpacity: alpha,
      });
      break;
    }
    case 'ellipse': {
      const r = userRect(a);
      page.drawEllipse({
        x: r.x + r.w / 2, y: r.y + r.h / 2,
        xScale: r.w / 2, yScale: r.h / 2,
        borderColor: color, borderWidth: a.width, borderOpacity: alpha,
      });
      break;
    }
    case 'line':
    case 'arrow': {
      page.drawLine({
        start: { x: a.x1, y: a.y1 },
        end: { x: a.x2, y: a.y2 },
        thickness: a.width, color, opacity: alpha, lineCap: LineCapStyle.Round,
      });
      if (a.type === 'arrow') {
        const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
        const len = Math.max(9, a.width * 3.4);
        for (const off of [-0.42, 0.42]) {
          page.drawLine({
            start: { x: a.x2, y: a.y2 },
            end: {
              x: a.x2 - len * Math.cos(ang + off),
              y: a.y2 - len * Math.sin(ang + off),
            },
            thickness: a.width, color, opacity: alpha, lineCap: LineCapStyle.Round,
          });
        }
      }
      break;
    }
    case 'image': {
      const img = await embedImageCached(doc, cache, a);
      // Visual rect (scale-1 viewport px == PDF points), then rotation-aware
      // placement: anchor at the visual bottom-left corner.
      const q1 = g.toView(a.x1, a.y1);
      const q2 = g.toView(a.x2, a.y2);
      const sx1 = Math.min(q1.x, q2.x), sx2 = Math.max(q1.x, q2.x);
      const sy1 = Math.min(q1.y, q2.y), sy2 = Math.max(q1.y, q2.y);
      const anchor = g.toPdf(sx1, sy2);
      page.drawImage(img, {
        x: anchor.x, y: anchor.y,
        width: sx2 - sx1, height: sy2 - sy1,
        rotate: degrees(g.angleDeg),
      });
      break;
    }
  }
}

function userRect(a) {
  return {
    x: Math.min(a.x1, a.x2),
    y: Math.min(a.y1, a.y2),
    w: Math.abs(a.x2 - a.x1),
    h: Math.abs(a.y2 - a.y1),
  };
}

/** Build final bytes with annotations (and optional badge) burned in. */
export async function buildBurnedBytes({ badge }) {
  const doc = await loadWorkingDoc();
  await burnAnnotations(doc, { badge });
  doc.setProducer('Orion PDF Editor');
  doc.setCreator('Orion PDF Editor');
  return doc.save();
}

export async function exportPdf({ badge }) {
  const bytes = await buildBurnedBytes({ badge });
  download(bytes, baseName() + '-orion.pdf');
  S.dirty = false;
  bus.emit('exported');
  return bytes.length;
}

/** Parse a PDF date string (D:YYYYMMDDHHmmSS…) into a display string. */
function pdfDate(str) {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(String(str || ''));
  if (!m) return '';
  const d = new Date(
    Number(m[1]), Number(m[2] || 1) - 1, Number(m[3] || 1),
    Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)
  );
  return isNaN(d.getTime()) ? '' : d.toLocaleString();
}

/** Full document properties via pdf.js metadata + live state. */
export async function getDocumentInfo() {
  let info = {};
  try {
    const meta = await S.pdf.getMetadata();
    info = (meta && meta.info) || {};
  } catch (e) { /* metadata is optional */ }
  const page = await S.pdf.getPage(S.page);
  const vp = page.getViewport({ scale: 1 });
  return {
    title: info.Title || '',
    author: info.Author || '',
    subject: info.Subject || '',
    keywords: info.Keywords || '',
    creator: info.Creator || '',
    producer: info.Producer || '',
    created: pdfDate(info.CreationDate),
    modified: pdfDate(info.ModDate),
    version: info.PDFFormatVersion || '',
    pages: S.pageCount,
    fileSize: S.bytes ? S.bytes.length : 0,
    pageSize: Math.round(vp.width) + ' × ' + Math.round(vp.height) + ' pt',
  };
}

/** Extract a page range (with annotations burned) into a new download. */
export async function extractRange(rangeStr) {
  const indices = parseRange(rangeStr, S.pageCount);
  const burned = await buildBurnedBytes({ badge: false });
  const src = await PDFDocument.load(burned);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, indices);
  copied.forEach((p) => out.addPage(p));
  out.setProducer('Orion PDF Editor');
  const bytes = await out.save();
  download(bytes, baseName() + '-extract.pdf');
  return indices.length;
}

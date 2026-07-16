/**
 * Orion editor — entry point.
 *
 * Vendor UMD scripts (pdf.js, pdf-lib) are loaded before this module.
 * We verify they exist before importing the app modules, because
 * viewer.js/docops.js touch the globals at import time.
 */
'use strict';

const missing = [];
if (!window.pdfjsLib) missing.push('pdf.js (vendor/pdf.min.js)');
if (!window.PDFLib) missing.push('pdf-lib (vendor/pdf-lib.min.js)');

if (missing.length) {
  const dz = document.getElementById('dropzone');
  if (dz) {
    dz.innerHTML =
      '<div class="dz-star">✦</div>' +
      '<h1 class="dz-title">Missing libraries</h1>' +
      '<p class="dz-sub">Could not load: ' + missing.join(', ') + '</p>' +
      '<p class="dz-fine mono">Run “npm install &amp;&amp; npm run vendor” and reload.</p>';
  }
} else {
  const { initUI } = await import('./ui.js');
  const { initAnnotEvents } = await import('./annots.js');
  const { S } = await import('./state.js');
  const { renderPage } = await import('./viewer.js');

  initUI();
  initAnnotEvents();

  // Re-fit the page when the window resizes (fit mode only).
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (!S.pdf || S.zoomMode !== 'fit') return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderPage(), 140);
  });
}

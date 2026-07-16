#!/usr/bin/env node
/**
 * Copies vendored library builds from node_modules into public/vendor.
 * Run after `npm install` if you ever upgrade pdf-lib / pdfjs-dist.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'public', 'vendor');

const files = [
  ['node_modules/pdf-lib/dist/pdf-lib.min.js', 'pdf-lib.min.js'],
  ['node_modules/pdfjs-dist/build/pdf.min.js', 'pdf.min.js'],
  ['node_modules/pdfjs-dist/build/pdf.worker.min.js', 'pdf.worker.min.js'],
];

fs.mkdirSync(out, { recursive: true });
for (const [src, dest] of files) {
  fs.copyFileSync(path.join(root, src), path.join(out, dest));
  console.log(`vendored ${dest}`);
}

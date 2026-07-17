#!/usr/bin/env node
/**
 * Orion PDF Editor — zero-dependency static server.
 *
 * Serves ./public with sane security headers. No runtime dependencies,
 * so hosting cost is effectively zero (or deploy ./public to any static host).
 *
 * Usage:  node server.js          (default port 4870)
 *         PORT=8080 node server.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 4870;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    // Firebase Auth SDK loads from gstatic and talks to Google identity APIs.
    "script-src 'self' https://www.gstatic.com https://apis.google.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https://*.googleusercontent.com https://graph.facebook.com https://avatars.githubusercontent.com",
    "connect-src 'self' data: blob: https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://firestore.googleapis.com https://*.workers.dev",
    "worker-src 'self' blob:",
    "frame-src 'self' blob: https://*.firebaseapp.com https://accounts.google.com", // print preview + OAuth popups
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    'upgrade-insecure-requests',
  ].join('; '),
};

function send(res, status, headers, body) {
  res.writeHead(status, Object.assign({}, SECURITY_HEADERS, headers));
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { 'Content-Type': 'text/plain' }, 'Method Not Allowed');
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
  } catch {
    return send(res, 400, { 'Content-Type': 'text/plain' }, 'Bad Request');
  }

  if (urlPath === '/') urlPath = '/index.html';

  // Resolve inside ROOT only (blocks path traversal).
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    return send(res, 403, { 'Content-Type': 'text/plain' }, 'Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    let target = filePath;
    if (!err && stat.isDirectory()) target = path.join(filePath, 'index.html');

    fs.readFile(target, (readErr, data) => {
      if (readErr) {
        return send(res, 404, { 'Content-Type': 'text/html; charset=utf-8' },
          '<!doctype html><meta charset="utf-8"><title>404</title>' +
          '<body style="font-family:sans-serif;background:#ffffff;color:#171c2b;display:grid;place-items:center;height:100vh;margin:0">' +
          '<div style="text-align:center"><h1 style="font-size:64px;margin:0">404</h1>' +
          '<p>That page drifted out of orbit.</p><a href="/" style="color:#a8730f">Back to Orion</a></div>');
      }
      const ext = path.extname(target).toLowerCase();
      const isVendor = target.includes(`${path.sep}vendor${path.sep}`);
      send(res, 200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': isVendor ? 'public, max-age=86400' : 'no-cache',
        'Content-Length': data.length,
      }, req.method === 'HEAD' ? undefined : data);
    });
  });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ✦ Orion PDF Editor');
  console.log(`  → http://${HOST}:${PORT}`);
  console.log('');
  console.log('  Landing page : /');
  console.log('  Editor       : /editor.html');
  console.log('  Stop         : Ctrl+C');
  console.log('');
});

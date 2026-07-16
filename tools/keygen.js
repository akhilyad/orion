#!/usr/bin/env node
/**
 * Orion license key generator.
 *
 * You sell Premium for €1; this is how you mint the keys you deliver
 * after purchase (manually, or from a Stripe webhook — see README).
 *
 * Usage:
 *   node tools/keygen.js                 → 1 key
 *   node tools/keygen.js 25              → 25 keys
 *   node tools/keygen.js --verify KEY    → check a key
 *   node tools/keygen.js 5 --salt=MYSALT → custom salt
 *
 * IMPORTANT: The salt below must match ORION_LICENSE_SALT in
 * public/js/license.js. Change BOTH before launch.
 */
'use strict';

const crypto = require('crypto');

// ── Keep in sync with public/js/license.js ─────────────────────────────
const DEFAULT_SALT = 'ORION-CHANGE-THIS-SALT-BEFORE-LAUNCH';
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I/L/O/0/1

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function checksumGroup(body, salt) {
  let h = fnv1a(body + '|' + salt);
  let out = '';
  for (let i = 0; i < 5; i++) {
    out += ALPHABET[h % ALPHABET.length];
    h = fnv1a(String(h) + body + salt);
  }
  return out;
}

function validateKey(key, salt) {
  const m = /^ORION-([A-Z2-9]{5})-([A-Z2-9]{5})-([A-Z2-9]{5})$/.exec(
    String(key || '').trim().toUpperCase()
  );
  if (!m) return false;
  return checksumGroup(m[1] + m[2], salt) === m[3];
}
// ───────────────────────────────────────────────────────────────────────

function randomGroup() {
  let out = '';
  const bytes = crypto.randomBytes(5);
  for (let i = 0; i < 5; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function generateKey(salt) {
  const a = randomGroup();
  const b = randomGroup();
  return `ORION-${a}-${b}-${checksumGroup(a + b, salt)}`;
}

// ── CLI ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let salt = DEFAULT_SALT;
let count = 1;
let verifyTarget = null;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--salt=')) salt = a.slice(7);
  else if (a === '--verify') verifyTarget = args[++i];
  else if (/^\d+$/.test(a)) count = Math.min(10000, parseInt(a, 10));
  else if (a === '--help' || a === '-h') {
    console.log('Usage: node tools/keygen.js [count] [--salt=SALT] [--verify KEY]');
    process.exit(0);
  }
}

if (verifyTarget) {
  const ok = validateKey(verifyTarget, salt);
  console.log(ok ? '✔ VALID' : '✘ INVALID');
  process.exit(ok ? 0 : 1);
}

if (salt === DEFAULT_SALT) {
  console.error('⚠  Using the DEFAULT salt. Change it in tools/keygen.js AND');
  console.error('   public/js/license.js before selling keys.\n');
}

for (let i = 0; i < count; i++) console.log(generateKey(salt));

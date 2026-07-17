/**
 * Orion license validation (browser side).
 *
 * Keys look like: ORION-XXXXX-XXXXX-XXXXX
 * The last group is a checksum of the first two + a salt.
 *
 * NOTE: client-side validation is deterrence, not DRM — appropriate for a
 * €1 product. Change ORION_LICENSE_SALT here AND in tools/keygen.js
 * before launch (they must match).
 */
(function () {
  'use strict';

  // ── Keep in sync with tools/keygen.js ──────────────────────────────
  var ORION_LICENSE_SALT = 'ORION-CHANGE-THIS-SALT-BEFORE-LAUNCH';
  var ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function checksumGroup(body, salt) {
    var h = fnv1a(body + '|' + salt);
    var out = '';
    for (var i = 0; i < 5; i++) {
      out += ALPHABET[h % ALPHABET.length];
      h = fnv1a(String(h) + body + salt);
    }
    return out;
  }

  function validateKey(key) {
    var m = /^ORION-([A-Z2-9]{5})-([A-Z2-9]{5})-([A-Z2-9]{5})$/.exec(
      String(key || '').trim().toUpperCase()
    );
    if (!m) return false;
    return checksumGroup(m[1] + m[2], ORION_LICENSE_SALT) === m[3];
  }
  // ───────────────────────────────────────────────────────────────────

  var STORAGE_KEY = 'orion.license.v1';

  function storedKey() {
    try {
      return localStorage.getItem(STORAGE_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  window.OrionLicense = {
    /** True when a valid Premium key is activated on this browser. */
    isPremium: function () {
      var k = storedKey();
      return !!k && validateKey(k);
    },

    /** Try to activate a key. Returns true on success. */
    activate: function (key) {
      if (!validateKey(key)) return false;
      try {
        localStorage.setItem(STORAGE_KEY, String(key).trim().toUpperCase());
      } catch (e) {
        /* private mode: session-only premium via memory flag */
        window.__orionSessionPremium = true;
      }
      return true;
    },

    /** Remove the stored key. */
    deactivate: function () {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (e) { /* ignore */ }
      window.__orionSessionPremium = false;
    },

    /** The activated key (masked for display). */
    maskedKey: function () {
      var k = storedKey();
      if (!k) return '';
      return k.slice(0, 6) + '•••••-•••••-' + k.slice(-5);
    },

    validateKey: validateKey,
  };

  // Session fallback for private browsing.
  var _isPremium = window.OrionLicense.isPremium;
  window.OrionLicense.isPremium = function () {
    return !!window.__orionSessionPremium || _isPremium();
  };

  /* ── Free trial counter ─────────────────────────────────────────────
   * Every document opened without a license counts as one "try".
   * After the configured number of tries, the editor asks for €1.
   * Stored per browser; private mode falls back to a session counter.
   */
  var TRIAL_KEY = 'orion.trial.v1';
  var _sessionTries = 0;

  function trialLimit() {
    var cfg = window.ORION_CONFIG || {};
    var n = (cfg.limits || {}).freeTries;
    return typeof n === 'number' && n >= 0 ? n : 2;
  }

  function readTries() {
    try {
      var n = parseInt(localStorage.getItem(TRIAL_KEY), 10);
      return isNaN(n) || n < 0 ? _sessionTries : Math.max(n, _sessionTries);
    } catch (e) {
      return _sessionTries;
    }
  }

  window.OrionTrial = {
    limit: trialLimit,
    used: readTries,
    remaining: function () {
      return Math.max(0, trialLimit() - readTries());
    },
    exhausted: function () {
      return readTries() >= trialLimit();
    },
    /** Count one try (call when a document opens without a license). */
    record: function () {
      var n = readTries() + 1;
      _sessionTries = n;
      try {
        localStorage.setItem(TRIAL_KEY, String(n));
      } catch (e) { /* private mode: session counter already updated */ }
      return n;
    },
  };
})();

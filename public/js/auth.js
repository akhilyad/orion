/**
 * Orion — accounts page (account.html).
 *
 * Firebase Authentication with Google, GitHub, Facebook and phone number.
 * Reads window.ORION_CONFIG.firebase; while that is null the page runs in
 * placeholder mode: provider buttons are disabled, a notice explains that
 * sign-in is being set up, and key activation remains the fallback.
 *
 * The Firebase compat SDK is loaded dynamically from gstatic only when a
 * config is present, so the strict-CSP, fully-offline story is unchanged
 * until accounts are actually enabled.
 */
(function () {
  'use strict';

  var cfg = (window.ORION_CONFIG && window.ORION_CONFIG.firebase) || null;

  var $ = function (id) { return document.getElementById(id); };
  var signedOut = $('auth-signed-out');
  var signedIn = $('auth-signed-in');
  var notice = $('auth-notice');
  var errEl = $('auth-error');
  var phoneStep = $('phone-step');
  var codeStep = $('phone-code-step');

  function showError(msg) {
    if (!errEl) return;
    errEl.textContent = msg;
    errEl.hidden = !msg;
  }

  function toast(msg) {
    var region = $('toasts');
    if (!region) return;
    var t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    region.appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }

  /* ── Placeholder mode: no Firebase config yet ───────────────────── */
  if (!cfg) {
    if (notice) notice.hidden = false;
    ['btn-google', 'btn-github', 'btn-facebook', 'btn-phone'].forEach(function (id) {
      var b = $(id);
      if (!b) return;
      b.disabled = true;
      b.addEventListener('click', function () {
        toast('Sign-in is being set up — use your license key meanwhile.');
      });
    });
    return;
  }

  /* ── Live mode: load the Firebase compat SDK, then wire up auth ── */
  var SDK_BASE = 'https://www.gstatic.com/firebasejs/10.14.1/';
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }

  loadScript(SDK_BASE + 'firebase-app-compat.js')
    .then(function () { return loadScript(SDK_BASE + 'firebase-auth-compat.js'); })
    .then(init)
    .catch(function (e) {
      showError('Could not load sign-in. Check your connection and reload.');
      console.error(e);
    });

  function init() {
    firebase.initializeApp(cfg);
    var auth = firebase.auth();

    /**
     * Check the Firestore entitlement written by the Stripe webhook:
     * entitlements/{email} → { premium: true }. Uses the REST API with the
     * user's ID token so no extra SDK is needed; security rules only allow
     * reading your own document.
     */
    function checkEntitlement(user) {
      if (!user.email) {
        // Phone-only accounts have no email to match a Stripe purchase.
        return Promise.resolve(false);
      }
      // Preferred: the free Cloudflare Worker backend (see worker/).
      var api = (window.ORION_CONFIG && window.ORION_CONFIG.entitlementApi) || '';
      if (api) {
        return user.getIdToken()
          .then(function (token) {
            return fetch(api.replace(/\/$/, '') + '/entitlement', {
              headers: { Authorization: 'Bearer ' + token },
            });
          })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) { return !!(d && d.premium); })
          .catch(function () { return false; });
      }
      // Fallback: read Firestore directly (Cloud Function pipeline).
      var url = 'https://firestore.googleapis.com/v1/projects/' +
        encodeURIComponent(cfg.projectId) +
        '/databases/(default)/documents/entitlements/' +
        encodeURIComponent(user.email.toLowerCase());
      return user.getIdToken()
        .then(function (token) {
          return fetch(url, { headers: { Authorization: 'Bearer ' + token } });
        })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (doc) {
          return !!(doc && doc.fields && doc.fields.premium &&
            doc.fields.premium.booleanValue === true);
        })
        .catch(function () { return false; });
    }

    auth.onAuthStateChanged(function (user) {
      var isIn = !!user;
      if (signedOut) signedOut.hidden = isIn;
      if (signedIn) signedIn.hidden = !isIn;
      if (!isIn) {
        if (window.OrionAccount) window.OrionAccount.setPremium('', false);
        return;
      }
      var name = $('user-name'), detail = $('user-detail'), avatar = $('user-avatar');
      if (name) name.textContent = user.displayName || 'Signed in';
      if (detail) detail.textContent = user.email || user.phoneNumber || '';
      if (avatar) {
        if (user.photoURL) { avatar.src = user.photoURL; avatar.hidden = false; }
        else { avatar.hidden = true; }
      }
      checkEntitlement(user).then(function (premium) {
        if (window.OrionAccount) {
          window.OrionAccount.setPremium(user.email || '', premium);
        }
        if (detail && user.email) {
          detail.textContent = user.email +
            (premium ? ' · Premium active ✦' : ' · Free plan');
        }
        if (premium) toast('Premium is active on this browser. ✦');
      });
    });

    function popup(provider) {
      showError('');
      auth.signInWithPopup(provider).catch(function (e) {
        if (e && e.code === 'auth/popup-closed-by-user') return;
        showError(e && e.message ? e.message : 'Sign-in failed. Try again.');
      });
    }

    var on = function (id, fn) { var b = $(id); if (b) b.addEventListener('click', fn); };

    on('btn-google', function () { popup(new firebase.auth.GoogleAuthProvider()); });
    on('btn-github', function () { popup(new firebase.auth.GithubAuthProvider()); });
    on('btn-facebook', function () { popup(new firebase.auth.FacebookAuthProvider()); });
    on('btn-signout', function () { auth.signOut(); });

    /* Phone: reveal the step, verify via invisible reCAPTCHA, confirm code. */
    var recaptcha = null;
    var confirmation = null;

    on('btn-phone', function () {
      if (phoneStep) phoneStep.hidden = !phoneStep.hidden;
    });

    on('phone-send', function () {
      showError('');
      var number = ($('phone-number') && $('phone-number').value || '').trim();
      if (!/^\+[0-9 ]{7,18}$/.test(number)) {
        showError('Enter your number in international format, e.g. +49 151 23456789.');
        return;
      }
      if (!recaptcha) {
        recaptcha = new firebase.auth.RecaptchaVerifier('recaptcha-container', { size: 'normal' });
      }
      auth.signInWithPhoneNumber(number.replace(/ /g, ''), recaptcha)
        .then(function (result) {
          confirmation = result;
          if (codeStep) codeStep.hidden = false;
          toast('Code sent — check your phone.');
        })
        .catch(function (e) {
          showError(e && e.message ? e.message : 'Could not send the code.');
          if (recaptcha) { recaptcha.clear(); recaptcha = null; }
        });
    });

    on('phone-verify', function () {
      showError('');
      var code = ($('phone-code') && $('phone-code').value || '').trim();
      if (!confirmation || !code) { showError('Enter the 6-digit code from the SMS.'); return; }
      confirmation.confirm(code).catch(function () {
        showError('That code did not match. Try again.');
      });
    });
  }
})();

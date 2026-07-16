/**
 * Orion landing page: constellation canvas, pricing actions, license modal.
 */
(function () {
  'use strict';

  var CFG = window.ORION_CONFIG || {};
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── Toasts ─────────────────────────────────────────────────────── */
  function toast(msg, gold) {
    var region = document.getElementById('toasts');
    if (!region) return;
    var el = document.createElement('div');
    el.className = 'toast' + (gold ? ' is-gold' : '');
    el.textContent = msg;
    region.appendChild(el);
    setTimeout(function () { el.remove(); }, 3600);
  }

  /* ── Constellation canvas (Orion) ───────────────────────────────── */
  var canvas = document.getElementById('constellation');
  if (canvas) {
    var ctx = canvas.getContext('2d');
    var stars = [];
    var t0 = performance.now();

    // Orion's principal stars, normalized to the hero box.
    var ORION = [
      { x: 0.50, y: 0.06, r: 1.6 },  // Meissa (head)
      { x: 0.38, y: 0.20, r: 2.6 },  // Betelgeuse
      { x: 0.63, y: 0.24, r: 2.1 },  // Bellatrix
      { x: 0.46, y: 0.50, r: 1.9 },  // Alnitak
      { x: 0.505, y: 0.53, r: 1.9 }, // Alnilam
      { x: 0.55, y: 0.56, r: 1.9 },  // Mintaka
      { x: 0.40, y: 0.84, r: 2.0 },  // Saiph
      { x: 0.66, y: 0.88, r: 2.7 },  // Rigel
    ];
    var LINKS = [[0, 1], [0, 2], [1, 3], [2, 5], [3, 4], [4, 5], [3, 6], [5, 7]];

    function seedStars() {
      stars = [];
      for (var i = 0; i < 130; i++) {
        stars.push({
          x: Math.random(),
          y: Math.random(),
          r: Math.random() * 1.1 + 0.25,
          phase: Math.random() * Math.PI * 2,
          speed: Math.random() * 1.4 + 0.4,
        });
      }
    }

    function sizeCanvas() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function draw(now) {
      var w = canvas.clientWidth || canvas.parentElement.clientWidth;
      var h = canvas.clientHeight || canvas.parentElement.clientHeight;
      var t = (now - t0) / 1000;
      ctx.clearRect(0, 0, w, h);

      // Background stars (twinkle).
      for (var i = 0; i < stars.length; i++) {
        var s = stars[i];
        var a = reduceMotion ? 0.5 : 0.28 + 0.42 * (0.5 + 0.5 * Math.sin(t * s.speed + s.phase));
        ctx.globalAlpha = a;
        ctx.fillStyle = '#ede7d9';
        ctx.beginPath();
        ctx.arc(s.x * w, s.y * h, s.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // Constellation zone: right side on wide screens, centered on small.
      var cx = w > 860 ? w * 0.72 : w * 0.5;
      var cw = Math.min(w * 0.42, 420);
      var cy = h * 0.12;
      var ch = h * 0.76;

      function px(p) { return { x: cx - cw / 2 + p.x * cw, y: cy + p.y * ch }; }

      // Hairline links.
      ctx.globalAlpha = 0.28;
      ctx.strokeStyle = '#f0b34e';
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      for (var l = 0; l < LINKS.length; l++) {
        var a1 = px(ORION[LINKS[l][0]]);
        var b1 = px(ORION[LINKS[l][1]]);
        ctx.moveTo(a1.x, a1.y);
        ctx.lineTo(b1.x, b1.y);
      }
      ctx.stroke();

      // Principal stars with glow.
      for (var k = 0; k < ORION.length; k++) {
        var p = px(ORION[k]);
        var pulse = reduceMotion ? 1 : 1 + 0.18 * Math.sin(t * 1.3 + k * 1.7);
        var grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, ORION[k].r * 7);
        grad.addColorStop(0, 'rgba(240,179,78,0.85)');
        grad.addColorStop(1, 'rgba(240,179,78,0)');
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, ORION[k].r * 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffe9c4';
        ctx.beginPath();
        ctx.arc(p.x, p.y, ORION[k].r * pulse, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (!reduceMotion) requestAnimationFrame(draw);
    }

    seedStars();
    sizeCanvas();
    requestAnimationFrame(draw);
    window.addEventListener('resize', function () {
      sizeCanvas();
      if (reduceMotion) requestAnimationFrame(draw);
    });
  }

  /* ── Modals ─────────────────────────────────────────────────────── */
  function openModal(id) {
    var m = document.getElementById(id);
    if (!m) return;
    m.hidden = false;
    var input = m.querySelector('input');
    if (input) setTimeout(function () { input.focus(); }, 60);
  }
  function closeModals() {
    document.querySelectorAll('.modal-backdrop').forEach(function (m) { m.hidden = true; });
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t.closest('.js-close')) return closeModals();
    if (t.classList.contains('modal-backdrop')) return closeModals();

    if (t.closest('.js-activate')) {
      e.preventDefault();
      closeModals();
      openModal('modal-activate');
      return;
    }
    if (t.closest('.js-buy')) {
      e.preventDefault();
      closeModals();
      var link = (CFG.premiumPaymentLink || '').trim();
      if (link) {
        window.open(link, '_blank', 'noopener');
      } else {
        openModal('modal-buy');
      }
      return;
    }
    if (t.closest('.js-sales')) {
      e.preventDefault();
      window.location.href =
        'mailto:' + (CFG.salesEmail || 'sales@example.com') +
        '?subject=' + encodeURIComponent('Orion Enterprise — 10 seats');
      return;
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeModals();
  });

  /* ── License activation ─────────────────────────────────────────── */
  var submit = document.getElementById('license-submit');
  var input = document.getElementById('license-input');
  var errEl = document.getElementById('license-error');

  function tryActivate() {
    var key = (input.value || '').trim();
    if (window.OrionLicense.activate(key)) {
      errEl.hidden = true;
      closeModals();
      toast('Premium activated ✦ Welcome aboard.', true);
      reflectLicense();
    } else {
      errEl.hidden = false;
      input.focus();
      input.select();
    }
  }
  if (submit) submit.addEventListener('click', tryActivate);
  if (input) {
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') tryActivate();
    });
  }

  function reflectLicense() {
    if (!window.OrionLicense.isPremium()) return;
    document.querySelectorAll('.js-activate').forEach(function (b) {
      b.textContent = '✦ Premium active';
    });
    document.querySelectorAll('.js-buy').forEach(function (b) {
      if (b.classList.contains('btn-inline')) return;
      b.textContent = '✦ Premium active';
      b.disabled = true;
      b.style.opacity = '0.65';
      b.style.cursor = 'default';
    });
  }

  /* ── Footer version ─────────────────────────────────────────────── */
  var ver = document.querySelector('.footer-ver');
  if (ver && CFG.version) ver.textContent = 'v' + CFG.version;

  reflectLicense();
})();

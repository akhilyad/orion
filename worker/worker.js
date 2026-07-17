/**
 * Orion — free entitlement backend (Cloudflare Worker, no Firebase Blaze).
 *
 * Two routes:
 *
 *   POST /stripe-webhook
 *     Stripe calls this on checkout.session.completed (grant premium) and
 *     customer.subscription.deleted (revoke). The signature is verified
 *     with STRIPE_WEBHOOK_SECRET; entitlements live in the ENTITLEMENTS
 *     KV namespace under "email:<lowercased email>".
 *
 *   GET /entitlement
 *     Called by the website after Firebase sign-in, with the user's
 *     Firebase ID token as "Authorization: Bearer <token>". The token is
 *     verified against Google's public JWKS (issuer + audience + expiry +
 *     RS256 signature), then the caller's own entitlement is returned:
 *     { premium: true|false }.
 *
 *   POST /trial
 *     Called by the editor before granting a free-trial document open on
 *     a browser with no license/account. Increments a per-IP counter in
 *     KV (IP hashed, never stored raw) and reports whether this device's
 *     network is still within the free-trial allowance — a second,
 *     server-enforced layer on top of the client's own localStorage
 *     counter, since that one alone is trivially reset (incognito mode,
 *     clearing storage, a throwaway email address does not matter here
 *     since the trial was never tied to email).
 *
 * Secrets (wrangler secret put ...):
 *   STRIPE_WEBHOOK_SECRET   whsec_... from the Stripe webhook endpoint
 *   STRIPE_SECRET_KEY       sk_live_... (optional — only needed so a
 *                           subscription cancellation can be mapped back
 *                           to the customer's email for revocation)
 *
 * Vars (wrangler.toml):
 *   FIREBASE_PROJECT_ID     e.g. "orionpdf-e74a9"
 *   FREE_TRIES              e.g. "1" — must match limits.freeTries in
 *                           public/js/config.js
 */

const JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

let jwksCache = { keys: null, fetchedAt: 0 };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS),
  });
}

/* ── helpers ─────────────────────────────────────────────────────── */

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ── Stripe signature verification ───────────────────────────────── */

async function verifyStripeSignature(body, header, secret) {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i), p.slice(i + 1)];
    })
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  // Reject events older than 5 minutes (replay protection).
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${body}`));
  return timingSafeEqual(bytesToHex(mac), v1);
}

/* ── Firebase ID token verification ──────────────────────────────── */

async function getGoogleJwks() {
  const age = Date.now() - jwksCache.fetchedAt;
  if (jwksCache.keys && age < 60 * 60 * 1000) return jwksCache.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error('JWKS fetch failed');
  const { keys } = await res.json();
  jwksCache = { keys, fetchedAt: Date.now() };
  return keys;
}

async function verifyFirebaseToken(token, projectId) {
  const segs = String(token || '').split('.');
  if (segs.length !== 3) return null;

  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(segs[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(segs[1])));
  } catch (e) {
    return null;
  }

  const now = Date.now() / 1000;
  if (header.alg !== 'RS256') return null;
  if (payload.aud !== projectId) return null;
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) return null;
  if (!(payload.exp > now)) return null;

  const jwk = (await getGoogleJwks()).find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(segs[2]),
    new TextEncoder().encode(`${segs[0]}.${segs[1]}`)
  );
  return ok ? payload : null;
}

/* ── routes ──────────────────────────────────────────────────────── */

async function handleStripeWebhook(request, env) {
  const body = await request.text();
  const valid = await verifyStripeSignature(
    body, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET
  );
  if (!valid) return json(400, { error: 'invalid signature' });

  const event = JSON.parse(body);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email =
      (session.customer_details && session.customer_details.email) ||
      session.customer_email;
    if (email) {
      await env.ENTITLEMENTS.put(
        'email:' + email.toLowerCase(),
        JSON.stringify({ premium: true, since: event.created, sessionId: session.id })
      );
    }
  } else if (event.type === 'customer.subscription.deleted' && env.STRIPE_SECRET_KEY) {
    // Look the customer's email up via Stripe's REST API to revoke.
    const sub = event.data.object;
    const res = await fetch('https://api.stripe.com/v1/customers/' + sub.customer, {
      headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY },
    });
    if (res.ok) {
      const customer = await res.json();
      if (customer.email) {
        await env.ENTITLEMENTS.put(
          'email:' + customer.email.toLowerCase(),
          JSON.stringify({ premium: false, revokedAt: event.created })
        );
      }
    }
  }

  return json(200, { received: true });
}

/* ── Trial rate-limit by IP ──────────────────────────────────────── */

async function hashIp(ip) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  return bytesToHex(digest).slice(0, 32);
}

async function handleTrial(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!ip) return json(200, { allowed: true }); // no IP signal — fail open

  const limit = parseInt(env.FREE_TRIES, 10) || 1;
  const key = 'trial:' + (await hashIp(ip));

  const raw = await env.ENTITLEMENTS.get(key);
  const used = parseInt(raw, 10) || 0;

  if (used >= limit) {
    return json(200, { allowed: false, remaining: 0 });
  }

  // 180-day TTL so a long-dormant network doesn't stay blocked forever.
  await env.ENTITLEMENTS.put(key, String(used + 1), { expirationTtl: 60 * 60 * 24 * 180 });
  return json(200, { allowed: true, remaining: limit - (used + 1) });
}

async function handleEntitlement(request, env) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const payload = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID);
  if (!payload) return json(401, { error: 'invalid token' });

  const email = payload.email;
  if (!email || payload.email_verified === false) {
    return json(200, { premium: false, reason: 'no verified email on account' });
  }

  const raw = await env.ENTITLEMENTS.get('email:' + email.toLowerCase());
  const record = raw ? JSON.parse(raw) : null;
  return json(200, { premium: !!(record && record.premium) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method === 'POST' && url.pathname === '/stripe-webhook') {
      return handleStripeWebhook(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/entitlement') {
      return handleEntitlement(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/trial') {
      return handleTrial(request, env);
    }
    return json(404, { error: 'not found' });
  },
};

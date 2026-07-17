# ✦ Orion — the premium PDF editor that costs one euro

Orion is a complete, self-hostable PDF editor that runs **entirely in the
browser**. Files never leave the user's device — there is no upload, no
backend, no per-user processing cost. That is what makes the €1 price point
work: your only recurring cost is static hosting, which is free on every
major platform.

**Two pages ship in the box:**

| Page | What it is |
|---|---|
| `/` (index.html) | Marketing landing page: features, bucketized pricing, FAQ, license activation |
| `/editor.html` | The full PDF editor application |

---

## Features

### Stargazer (Free trial — €0, 1 document)
The landing page loads with no gate, and the editor opens freely. A visitor's
first **document** gets the core toolset — viewing, zooming, find, annotations
(text, pen, shapes, highlight), and page organization. Premium tools (text
editing, find & replace, signatures, stamps, watermarks, page numbers, forms,
merging, extraction, metadata, optimize, badge-free export) stay locked during
the trial. When they open a second document, the editor shows the upgrade
popup (buy €1 / activate a key). The try counter lives in `localStorage`
(`orion.trial.v1`); the limit is `limits.freeTries` in `public/js/config.js`.
- Core tools for 1 document — no sign-up
- Exports carry a small "Made with Orion" badge until Premium
- Full keyboard map (see the in-app **Help → Keyboard Shortcuts** dialog)

### The editor
A desktop-class shell: **File / Edit / View / Tools / Help menu bar** with
shortcuts, a main toolbar, a left icon rail (Pages · Marks · Files · Notes
panels), a right properties rail (colors, stroke, opacity, font), a status
bar, and a right-click context menu.

- Open, view, zoom (Fit Width / Fit Page / manual), and navigate PDFs of any size
- **Find** (Ctrl+F) with highlighted matches and prev/next stepping
- **Edit Text** (T) — dotted boxes outline the page's text; click one and retype
  it inline, right on the page (rotation-aware); drag the border to move the block
- **Select Text** (I) — drag over page text to select it live, Ctrl+C to copy
- **Add Text** (A) — a box rides the cursor; click to anchor, type directly on
  the page, drag the dotted border to reposition
- **Find & Replace** (Ctrl+H) — one-by-one or replace-all across the document
- Annotate: text, pen, highlighter, area highlight, rectangle, ellipse, line, arrow
- **Hand tool** (H) to pan, **Eraser** (E) to remove marks under the cursor
- Move, edit (double-click, inline), and delete annotations; select all / cut /
  copy / paste; full undo/redo
- Per-annotation **color, stroke width, opacity, and font family**
- Rotate, delete, **duplicate**, **insert blank**, and drag-to-reorder pages
- ✍ **Signatures** — draw and place, exported as vector-quality PNG with transparency
- ⬛ **Stamps** — APPROVED / REJECTED / DRAFT / CONFIDENTIAL / REVIEWED / custom text
- ▣ **Insert images** — PNG, JPEG, WebP (auto-transcoded)
- 🖨 **Print** (Ctrl+P) — annotations burned in, straight to the browser print dialog
- ◈ **Watermarks** — diagonal stamp across every page, rotation-aware
- № **Page numbers** — four formats, bottom-centred on every page
- ✂ **Extract pages** — pull ranges (`1-3, 5`) into a new PDF, annotations included
- ☰ **Form filling** — text, checkbox, dropdown, radio; values written into the file
- ⚙ **Metadata editing** + **Document Properties** (Ctrl+D) viewer
- ◫ **Bookmarks & attachments** panels — outline navigation, embedded-file download
- ◉ **Lossless optimization** — object-stream rewrite, only applied if it shrinks the file
- Preferences (Ctrl+K): default color, font size, font family, author name

### Premium (€1 / month) — the hero bucket
Everything above with no document limit, and every premium tool unlocked:
text editing, find & replace, e-signatures, stamps, watermarks, page numbers,
form filling, merging, page extraction, metadata editing, lossless optimize,
and **badge-free** exports.

### Enterprise (€79 / year · 10 seats)
Same software; you sell volume keys + priority email support. Leads go to
`salesEmail` in `public/js/config.js`.

---

## Installation

Requirements: **Node.js 18+** (only for serving locally and generating keys —
the app itself is 100 % static files).

```bash
git clone <your-repo-url> orion
cd orion
npm install        # optional — vendor libs are already committed in public/vendor
```

`npm install` is only needed if you want to re-copy the vendor libraries
(`npm run vendor`) or upgrade them. A fresh clone runs as-is.

## How to run

```bash
npm start
```

Then open **http://127.0.0.1:4870** — the landing page — and click
"Open the editor", or go straight to **http://127.0.0.1:4870/editor.html**.

Options:

```bash
PORT=8080 npm start        # different port
npm run keygen             # generate 1 license key
npm run keygen 20          # generate 20 keys
node tools/keygen.js --verify ORION-XXXXX-XXXXX-XXXXX   # check a key
```

### 3. Deploy the `public/` folder anywhere static
There is no backend. Any static host works, free tier included:

| Host | Command / method |
|---|---|
| **Cloudflare Pages** | point at repo, build output dir = `public` |
| **Netlify** | drag-and-drop the `public/` folder, or `netlify deploy --dir=public` |
| **GitHub Pages** | serve the `public/` folder from a branch |
| **Vercel** | output directory `public`, no build command |

`server.js` is for local development; in production the static host replaces
it. If you self-host with nginx/Apache instead, copy the security headers
from `server.js` (especially `Content-Security-Policy`).

### Accounts + automatic premium activation — free path (recommended)

The webhook can run as a **Cloudflare Worker** instead of a Firebase Cloud
Function — completely free (100k requests/day), no Blaze plan, no card:

```bash
cd worker
npx wrangler login
npx wrangler kv namespace create ENTITLEMENTS   # paste the id into wrangler.toml
npx wrangler secret put STRIPE_WEBHOOK_SECRET    # whsec_... (from the Stripe webhook)
npx wrangler secret put STRIPE_SECRET_KEY        # optional: enables cancel-revoke
npx wrangler deploy                              # prints your worker URL
```

Point the Stripe webhook endpoint at `<worker-url>/stripe-webhook`
(events: `checkout.session.completed`, `customer.subscription.deleted`),
and paste the worker URL into `entitlementApi` in `public/js/config.js`.
The worker verifies Stripe signatures, stores entitlements in KV, and
serves `/entitlement` to signed-in users after verifying their Firebase ID
token against Google's public keys. To grant premium manually (e.g. for a
purchase made before the webhook existed):

```bash
npx wrangler kv key put --binding ENTITLEMENTS "email:you@example.com" '{"premium":true}' --remote
```

The same Worker also rate-limits the free trial by IP (`POST /trial`), as a
second layer on top of the client's `localStorage` counter — the client one
alone resets in incognito mode or after clearing storage, and a throwaway
email doesn't help bypass either one since the trial was never tied to
email. `FREE_TRIES` in `wrangler.toml` must match `limits.freeTries` in
`public/js/config.js`. It fails open (allows the trial) if `entitlementApi`
is empty or the Worker is unreachable, so the app still works without it.

### Accounts + automatic premium activation via Firebase (Blaze plan)

Sign-in (Google / GitHub / Facebook / phone) lives at `/account.html`, powered
by Firebase Auth — config goes in `ORION_CONFIG.firebase`. To make a Stripe
purchase unlock Premium automatically, deploy the included Cloud Function:

```bash
npm i -g firebase-tools
firebase login
firebase use <your-project-id>
cd functions && npm install && cd ..
firebase functions:secrets:set STRIPE_SECRET_KEY       # sk_live_... from Stripe
firebase functions:secrets:set STRIPE_WEBHOOK_SECRET   # whsec_... (created below)
firebase deploy --only functions,firestore
```

Then in the Stripe dashboard → Developers → Webhooks, add an endpoint
pointing at the deployed `stripeWebhook` URL and subscribe it to
`checkout.session.completed` and `customer.subscription.deleted`; copy the
signing secret into `STRIPE_WEBHOOK_SECRET`. Flow: buyer pays via the
Payment Link → webhook writes `entitlements/{email}` in Firestore → buyer
signs in on `/account.html` with the same email → Premium unlocks in that
browser. Requires the Blaze (pay-as-you-go) Firebase plan for functions;
Firestore reads at this scale stay within the free tier.

### The economics
- Hosting: €0 (static, client-side processing)
- Payment processing: Stripe's fee is the main cost per sale — on €1
  transactions fees eat a large share, so consider the €10/year annual
  variant or regional pricing if volume grows
- Support: the FAQ answers the common questions; files never touching your
  servers means no GDPR data-processing burden for document content

---

## Architecture

```
orion/
├── server.js               # zero-dependency static server (dev), CSP headers
├── package.json
├── tools/
│   ├── keygen.js           # license key generator / verifier (CLI)
│   └── vendor.js           # copies pdf.js + pdf-lib from node_modules
├── public/                 # ← deploy this folder
│   ├── index.html          # landing page
│   ├── editor.html         # editor app
│   ├── css/  site.css, editor.css
│   ├── js/
│   │   ├── config.js       # pricing, payment link, limits — edit before launch
│   │   ├── license.js      # key validation + trial counter + localStorage activation
│   │   ├── landing.js      # constellation canvas, modals
│   │   └── editor/
│   │       ├── main.js     # entry, vendor checks
│   │       ├── state.js    # shared state, event bus, undo/redo history
│   │       ├── viewer.js   # pdf.js rendering, thumbnails, zoom modes, coordinates
│   │       ├── annots.js   # annotation overlay: draw, hit-test, move, edit, clipboard
│   │       ├── docops.js   # pdf-lib: rotate/reorder/merge/watermark/forms/export
│   │       ├── features.js # search, find & replace, text-line engine, print, stamps, bookmarks
│   │       ├── inline.js   # inline WYSIWYG text editing (add/edit/select)
│   │       └── ui.js       # menu bar, panels, modals, shortcuts, trial + premium gate
│   ├── vendor/             # pdf.js 3.11.174 + pdf-lib 1.17.1 (committed)
│   └── assets/favicon.svg
```

Key design decisions:

- **Everything client-side.** pdf.js renders; pdf-lib rewrites. Documents are
  processed in browser memory only.
- **Annotations live in PDF user space** (points, y-up) and are converted
  through the live pdf.js viewport — so they stay glued to page content
  across zoom and page rotation, and export burns them exactly where the
  user saw them (including on pre-rotated pages).
- **Stable page identity.** Each page gets an id; annotations are keyed by
  id, so rotate/delete/reorder/merge never orphan them.
- **Undo/redo** snapshots bytes by reference + annotations by deep copy
  (12 levels).
- **Strict CSP** (`script-src 'self'`; no inline JS, no eval) served by
  `server.js` — replicate it in production.

## Security & privacy notes

- Documents are never transmitted anywhere; there's no analytics and no
  third-party requests except Google Fonts (self-host the fonts to remove
  even that).
- License validation is **client-side deterrence, not DRM**. A determined
  user can bypass it — which is the correct trade-off for a €1 product; the
  price *is* the anti-piracy strategy. Don't store anything sensitive behind
  it.
- Keys are format-validated offline (checksum + salt). Nothing about the
  buyer is embedded in the key.

## Honest limits

- Password-protected/encrypted PDFs can't be opened (a clear error is shown),
  and Orion can't *add* encryption yet — pdf-lib has no encryption support,
  so the Tools → Encrypt menu explains this honestly instead of faking it.
- "Edit Text" and "Find & Replace" work by **covering and retyping** — a white
  patch over the original run plus new text in a standard font. The original
  glyphs stay in the file underneath; text is not re-typeset or reflowed.
- Very large PDFs (500 MB+) are constrained by browser memory.
- The 2-try trial counter is enforced client-side (`localStorage`),
  consistent with the license model above.

## Scripts

| Command | What it does |
|---|---|
| `npm start` / `npm run dev` | serve `public/` at http://127.0.0.1:4870 |
| `npm run keygen [n]` | generate `n` license keys (default 1) |
| `node tools/keygen.js --verify KEY` | validate a key |
| `node tools/keygen.js --salt=... 5` | generate with a custom salt |
| `npm run vendor` | re-copy pdf.js/pdf-lib from `node_modules` into `public/vendor` |

## License

You own your deployment. Change the salt, set your payment link, ship it. ✦

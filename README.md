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

### Stargazer (Free — €0)
- Open, view, zoom, and navigate PDFs of any size
- Annotate: text, pen, highlighter, area highlight, rectangle, ellipse, line, arrow
- Move, edit, and delete annotations; full undo/redo
- Rotate, delete, and drag-to-reorder pages (thumbnail rail)
- Merge **1** extra PDF per document
- Export to PDF (with a small "Made with Orion" badge) and PNG
- Keyboard shortcuts throughout (V/T/P/H/R/E/L/A tools, Ctrl+Z/Y, Ctrl+S, arrows, +/−)

### Premium (€1 / month) — the hero bucket
Everything in Stargazer, plus:
- ✍ **Signatures** — draw and place, exported as vector-quality PNG with transparency
- ▣ **Insert images** — PNG, JPEG, WebP (auto-transcoded)
- ◈ **Watermarks** — diagonal stamp across every page, rotation-aware
- № **Page numbers** — four formats, bottom-centred on every page
- ✂ **Extract pages** — pull ranges (`1-3, 5`) into a new PDF, annotations included
- ☰ **Form filling** — text, checkbox, dropdown, radio; values written into the file
- ⚙ **Metadata editing** — title, author, subject, keywords
- ◉ **Lossless optimization** — object-stream rewrite, only applied if it shrinks the file
- **Unlimited merging** and **no badge** on exports

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
│   │   ├── license.js      # key validation + localStorage activation
│   │   ├── landing.js      # constellation canvas, modals
│   │   └── editor/
│   │       ├── main.js     # entry, vendor checks
│   │       ├── state.js    # shared state, event bus, undo/redo history
│   │       ├── viewer.js   # pdf.js rendering, thumbnails, zoom, coordinates
│   │       ├── annots.js   # annotation overlay: draw, hit-test, move, edit
│   │       ├── docops.js   # pdf-lib: rotate/reorder/merge/watermark/forms/export
│   │       └── ui.js       # all DOM wiring, modals, shortcuts, premium gate
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

- Password-protected/encrypted PDFs can't be opened (a clear error is shown).
- Existing PDF text can't be reflowed/retyped (that's true of most editors —
  Orion adds content on top; it doesn't re-typeset the original).
- Very large PDFs (500 MB+) are constrained by browser memory.
- Free-tier limits are enforced client-side, consistent with the license
  model above.

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

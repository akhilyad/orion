# ✦ Orion — the premium PDF editor that costs one euro

Orion is a complete, self-hostable PDF editor that runs **entirely in the
browser**. Files never leave the user's device — there is no upload, no
backend, no per-user processing cost. That is what makes the €1 price point
work: your only recurring cost is static hosting, which is free on every
major platform.

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
Same software; you sell volume keys + priority email support.

### The economics
- Hosting: €0 (static, client-side processing)
- Payment processing: Stripe's fee is the main cost per sale — on €1
  transactions fees eat a large share, so consider the €10/year annual
  variant or regional pricing if volume grows
- Support: the FAQ answers the common questions; files never touching your
  servers means no GDPR data-processing burden for document content

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


## License

You own your deployment. Change the salt, set your payment link, ship it. ✦

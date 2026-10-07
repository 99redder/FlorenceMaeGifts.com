# Florence Mae Gifts - Project Guide

## Important Rules

- **Last Updated Header Comment**: Anytime a page or file is updated, the `Last Updated` field in the file's header comment block must be updated to the current day's date. The header comment format is:
  ```
  <!--
    ======================================
  ; Title: [filename]
  ; Author: [author]
  ; Date Created: [date]
  ; Last Updated: [UPDATE THIS DATE]
  ; Description: [description]
  ; Sources Used: [sources]
  ;=====================================
  ----->
  ```

## Project Overview

**Florence Mae Gifts** is a static HTML/CSS/JavaScript website for a handmade crochet/amigurumi gifts business run by artist Megan from Salisbury, Maryland. The site serves as a portfolio, storefront, and contact point.

- **Domain**: www.florencemaegifts.com
- **Hosting**: GitHub Pages (CNAME configured)
- **Author/Developer**: Red (GitHub: 99redder)

## Tech Stack

- **HTML5** — Static pages, no framework
- **CSS3** — Single stylesheet (`fmg.css`) with CSS variables for theming
- **Vanilla JavaScript** — Theme toggle, HTML includes, image modal gallery
- **No npm/webpack/bundler** — the only build step is `python3 scripts/build_shop.py`, which generates the shop pages from `products.json` (see the 2026-10-06 update at the end of this file)
- **External services**: Google Fonts, Font Awesome v6, Formspree (contact form)
- **Custom font**: "Jennifer Lynne" (self-hosted in `logo-font/`)

## Architecture

The site uses a **client-side HTML include pattern** via `includeHTML.js`. Common components (header, nav, footer, sidebars) are separate HTML files loaded at runtime using the `w3-include-html` attribute and XMLHttpRequest.

### File Structure

```
├── index.html              # Home/landing page with product gallery
├── about.html              # About the artist
├── reviews.html            # Customer testimonials
├── request.html            # Custom order request page
├── disclaimers.html        # Legal/terms
├── header.html             # Shared site header (logo + flowers)
├── topnav.html             # Shared navigation bar
├── footer.html             # Shared footer (copyright, social links, last update)
├── rightcolumn.html        # Shared right sidebar (latest creations + contact form)
├── aboutleftcolumn.html    # About page content component
├── reviewsleftcolumn.html  # Reviews page content component
├── disclaimersleftcolumn.html # Disclaimers page content component
├── fmg.css                 # Main stylesheet (all styles)
├── theme.js                # Light/dark mode toggle with localStorage
├── includeHTML.js          # W3-style HTML include loader
├── images/                 # Product photos, icons, decorations
├── logo-font/              # Custom "Jennifer Lynne" web font files
├── CNAME                   # GitHub Pages domain config
└── .vscode/settings.json   # VSCode spell check dictionary
```

### Page Layout

- **Desktop**: 70% left column (content) + 25% right column (sidebar)
- **Responsive breakpoints**: 1024px (tablet), 800px (mobile), 480px (small mobile)

## Styling & Theming

- **Light theme**: Black text on white background
- **Dark theme**: White text on dark gray (#303030)
- **Accent color**: Pink/salmon (#FE6666, #FF6699, #FEA0AE)
- **Nav bar**: Light salmon (#fecac4)
- **Body font**: Lora (serif, 16px)
- **H1**: Jennifer Lynne custom font (100px desktop)
- **H2**: Sofia Sans Extra Condensed (96px)
- Theme preference persists via localStorage

## Key JavaScript Features

- `theme.js` — `setDefaultTheme()` and `setSelectedTheme()` for light/dark toggle
- `includeHTML.js` — Recursive AJAX loader for HTML component includes
- `index.html` inline script — Modal gallery (click-to-enlarge product images)

## External Integrations

- **Etsy**: florencemaegifts shop (5-star Star Seller)
- **Instagram**: florencemaegifts
- **Facebook Marketplace**: Secondary sales channel
- **Formspree**: Contact form backend (endpoint: xnqrpewl)

## Naming Conventions

- HTML pages: lowercase simple names (`about.html`, `reviews.html`)
- Components: descriptive names (`aboutleftcolumn.html`, `topnav.html`)
- CSS classes: semantic (`.leftcolumn`, `.rightcolumn`, `.topnav`, `.header`, `.footer`)
- Theme classes: `.light-theme`, `.dark-theme`
- Images: `example1.jpeg` through `example20.png` for gallery items

## Footer Update (Mandatory)

- **Any time any site content is changed**, update the visible `Last Updated` date in `footer.html` in the same change set.
- Treat this as a required step before commit/push.
- This is separate from the header comment `Last Updated` field, and both should be kept current when applicable.

---

## Session Update — 2026-02-12 (Stripe + Shop + Cloudflare)

### What was implemented

- Added dedicated shop architecture:
  - `shop.html` (Shop page)
  - `shopleftcolumn.html` (listing content)
  - nav update in `topnav.html` (Shop after Home)
- Synced Etsy listings one-time into local listing cards + modal detail blocks.
- Added modal gallery behavior:
  - per-listing thumbnails
  - click thumbnail swaps main image in modal
- Added Stripe test checkout integration:
  - fixed-price items use Stripe Payment Links (`buy.stripe.com`)
  - variable-price/size items use API checkout session creation via `price_...` IDs
- Added size-aware ordering UX:
  - size options extracted from Etsy listing variation dropdowns
  - modal shows dynamic size selector on variable items
  - selected size updates displayed price + selected Stripe `priceId`
- Added checkout outcome UX:
  - `?checkout=success` and `?checkout=cancel` now show a large dismissible confirmation modal
  - success copy includes: "Thank you for your order! ... Order details will be emailed to you shortly."
- Listing content refinements:
  - removed "Listed:" date/time rows from listing modals
  - added per-item Etsy review link in each modal opening in a separate window (`#reviews`)

### Backend/API (Cloudflare Worker)

New folder:

- `cloudflare/wrangler.toml`
- `cloudflare/src/worker.js`
- `cloudflare/README.md`

Endpoints:

- `GET /api/health`
- `POST /api/create-checkout-session`
- `POST /api/stripe-webhook`

Key behavior:

- Checkout session creation supports item + selected `priceId`.
- Webhook signature verification implemented in-worker using Stripe `t`/`v1` HMAC SHA-256 verification.
- Shipping address collection enabled in checkout session creation (`US` allowed countries).

### Deployment notes

- Worker deployed to `*.workers.dev` and routed via Cloudflare to:
  - `https://www.florencemaegifts.com/api/*`
- DNS must be Cloudflare proxied (orange cloud) for Worker routes to execute.
- Verified health endpoint and webhook delivery with 200 responses.

### Current checkout behavior

- Fixed-price items: direct Payment Link checkout.
- Size/variation items: create checkout session via `/api/create-checkout-session`, then redirect to Stripe-hosted checkout.
- Success/cancel redirect back to Shop with modal confirmation.

### Important operational notes

- This project remains static-site frontend on GitHub Pages, with runtime API handled by Cloudflare Worker.
- Stripe built-in email notifications are recommended for production alerts; test mode primarily uses events/logs/webhook delivery testing.
- Local helper files used for mapping are intentionally uncommitted/ignored:
  - `.stripe-live-created-map.json`
  - `.stripe-price-map.json`
  - `.stripe-size-price-map.json`
- Keep `STORE_ALLOWED_PRICE_IDS` as a Cloudflare Worker secret, not in committed config.

### Key commits during this session

- `77ca077` — Add modal gallery thumbnails from Etsy listing images
- `7285ebb` — Wire Stripe payment links in shop modals and reorder nav
- `33ce212` — Polish shop UX, fix Stripe button markup, add Cloudflare webhook worker
- `839740a` — Fix shop listing prices to mapped Stripe values
- `afc30cd` — Add size-based pricing selectors and footer date update
- `1bd0417` — Fix modal title sizing selector for injected modal content
- `a8cf5af` — Remove listed dates + add Etsy review links per modal
- `5b0bffb` — Route size-based orders through checkout session API
- `d63d017` — Require shipping address collection in Stripe checkout sessions
- `e5aa6e6` — Add large dismissible checkout success/cancel modal
- `542b65b` — Refine shop copy and confirmation wording



## Session Update — 2026-02-19 (SEO + AI Navigation)

### Goals from Chris
- Improve SEO for discovery around:
  - affordable high-quality crochet diaper sets and hats
  - Dragon Ball Z themed baby cosplay sets
  - crochet patterns and gift intent
- Make site easier for future AI agents to understand and navigate quickly.

### What was changed
- Updated `index.html` and `shop.html` head metadata:
  - stronger title + meta descriptions with target phrases
  - keywords meta, canonical URL, robots directive
  - Open Graph and Twitter card metadata
  - JSON-LD schema (`Store`) for richer machine-readable business context
- Updated `shopleftcolumn.html` with a short keyword-aligned intro paragraph under the shop header.
- Updated `footer.html` with links to `sitemap.xml` and `llms.txt` for crawler/agent discoverability.
- Added crawl/navigation helper files at repo root:
  - `robots.txt`
  - `sitemap.xml`
  - `llms.txt`

### Architecture note for future agents
- This repo currently has swapped page responsibilities:
  - `index.html` contains the modern shop/catalog behavior
  - `shop.html` contains older gallery/landing content
- Keep this in mind before renaming files or changing nav; verify live routes and includes first.

### SEO content focus guidance
When adding new listings or copy, naturally include variants of:
- "crochet diaper set", "crochet baby hat", "baby cosplay set"
- "Dragon Ball Z baby set", "DBZ inspired baby costume"
- "crochet pattern PDF", "beginner crochet baby hat pattern"
- gift-intent language like "baby shower gift" and "gift for new parents"

Avoid keyword stuffing; keep copy readable and specific to real products.


### Follow-up SEO pass — 2026-02-19 (technical)
- Normalized homepage canonical to `https://www.florencemaegifts.com/` (root).
- Added canonical + robots meta tags to `about.html`, `reviews.html`, `request.html`, and `disclaimers.html`.
- Improved page titles/descriptions for secondary pages to better match search intent and improve snippet quality.
- Updated nav label from "Gallery" to "Shop" in `topnav.html` for clearer user + crawler understanding.
- Improved shared header semantics and image alt text in `header.html` for accessibility/crawler clarity.


### Follow-up SEO pass — 2026-02-19 (landmarks + URL clarity)
- Added semantic `<main id="main-content" role="main">` landmarks to core pages (`index`, `shop`, `about`, `reviews`, `request`, `disclaimers`).
- Added `id="shop"` anchor on the primary catalog section in `index.html` for stable deep-linking.
- Updated nav to clarify IA:
  - `Shop` now points to `index.html#shop` (primary commercial intent page)
  - old `shop.html` relabeled as `Gallery Archive`
- Reduced `shop.html` sitemap priority/frequency to reduce keyword cannibalization with homepage shop intent.

---

## Session Update — 2026-02-26 (Admin System + Accounting Stack)

### What was added

A full password-gated admin system was added at `/admin.html` for Florence Mae Gifts, based on the Eastern Shore AI admin architecture and then adapted for FMG.

Implemented sections/tabs:
- Stats (default first tab)
- Tax Ledger
- Accounts (Trial Balance, Balance Sheet, Income Statement/P&L, Cash Flow, Journal)
- Reconciliation
- Year-End Close
- Audit Package

Booking Controls were intentionally removed from the Florence admin codebase.

### Admin + backend wiring

- `admin.html` now uses same-origin API wiring (`${window.location.origin}/api/contact` base) for Cloudflare Worker endpoints.
- `cloudflare/src/worker.js` was ported/expanded with tax/accounting endpoints.
- D1 migrations copied into `cloudflare/migrations/` (`0001` through `0010`) including accounting/journal tables and owner-funded income flag support.

### Tax/accounting capabilities now available

- Double-entry journal support with auto-posting from tax entries.
- Owner-funded non-revenue support (boolean flag-backed) and proper equity posting.
- Owner transfer flow in Tax Ledger (manual owner/business movement entries).
- Year-End Close Wizard:
  - preview + apply
  - step explanations
  - idempotent replace for same-year close entries.
- Audit Package builder:
  - year + document selection + select-all toggle
  - ZIP output with statement PDFs, CSV exports, optional receipts
  - includes `manifest.txt` for audit traceability.

### Stats system updates

- Stats tab added as first tab and default view.
- Historical data seeded from legacy tracker screenshot for:
  - 2023
  - 2024
  - 2025
- Monthly card now supports 3-year YoY comparison in one card.
- Item stats intentionally deferred until LLC cutover day (placeholder text shown).
- Stats auto-calculate from ledger data for non-seeded years.

### Sales entry + import workflow

- `Add Sale` is now manual one-sale entry.
- Sale form supports fee components:
  - processing
  - transaction
  - listing
  - shipping
  - marketing
  - other
- Separate `Import Sales` flow added for Etsy monthly CSV statements:
  - parses Etsy statement CSV format
  - maps Sale rows to income entries
  - maps fee/shipping/marketing rows to categorized expense entries
  - preview panel added before final import confirmation.

### Theming + UX

- FMG-branded visual pass applied to admin (pink/salmon palette aligned to site styling).
- Light/dark theme toggle added in admin header with persistence.
- Contrast fixes applied for light and dark modes.
- Top tab bar converted to pink gradient style with complementary hover edges.
- Dark mode tab text adjusted to black on pink gradient per user request.
- Blur toggle added to mask currency amounts for demo use.

### Notable FMG admin commits in this session

- `514cf58` — Initial FMG admin + backend scaffold copied from ESA
- `912a4e6` — FMG branding pass + hide booking controls in nav
- `c67074f` — Add Stats tab and pre-LLC dashboard structure
- `77ecdb6` — Remove booking controls functionality/dependencies
- `fd2e2b3` — Add theme toggle, live stats calculations, Add Sale flow
- `93ac77c` — Etsy CSV import + manual sale fee fields
- `bce254c` — Import preview + color contrast fixes
- `4f5a290` — Seed historical 2023–2025 stats + defer item stats
- `54fee2d` — YoY monthly stats + separate Import Sales workflow + pink tab styling
- `d5b8d1d` — Dark mode pink buttons use black text

### Operational notes for next session

- Before first live accounting use, ensure Cloudflare D1 binding `DB` and migrations are applied in FMG cloudflare project.
- Keep `wrangler.toml` local environment-specific values consistent with production DB name/id.
- Item stats should be activated/implemented at LLC cutover (currently intentionally placeholder).

## 2026-02-28 Updates (Quotes/Invoices + Shop Modal Shipping UX)

### Added
- Full admin Quotes + Invoices workflow parity wired into FMG:
  - Admin tabs/sections for Invoices and Quotes in `admin.html`
  - Add/View modal flows, edit/delete actions
  - Quote email send flow with accept/deny token links
  - Public quote accept/deny pages
  - Quote accept auto-converts to draft invoice
  - Invoice send flow with Stripe-hosted payment link
  - Public invoice payment success/cancel pages
  - Stripe webhook invoice-payment handling with accounting post + Stripe fee auto-expense
- Added D1 additive migrations:
  - `0011_add_invoices_tables.sql`
  - `0012_add_invoice_sent_at.sql`
  - `0013_add_quotes_tables.sql`
  - `0014_add_invoice_stripe_checkout_fields.sql`
  - `0015_add_customer_phone_to_invoices_quotes.sql`
- Shop listing modal UX updates in `shopleftcolumn.html`:
  - Added `Free Shipping` badge for all Buy Now card blocks
  - Added `*US sales only` note under every Buy Now button
  - Added theme-aware styles in `fmg.css`

### Critical gotchas
- Do not use raw SQL `BEGIN/COMMIT/ROLLBACK` in D1 request flow.
- Keep SQL placeholder/bind counts exactly aligned for every statement.
- Preserve idempotency for invoice payment posting to prevent duplicate accounting rows.
- Keep Stripe/Resend configuration environment-driven (`STRIPE_*`, `RESEND_*`, `FROM_EMAIL`, `TO_EMAIL`, optional `CC_EMAIL`).

---

## 2026-03-24 Updates (Mercari CSV Import + Stats Fix)

### What was added

- **Import Mercari Sales** button added to the Tax Ledger tab in `admin.html`, alongside the existing "Import Etsy Sales" button.
  - Parses Mercari "Custom Sales Report" CSV format (one row per item, all fees inline).
  - **Income**: records `Item Price` as "Product Sale" category.
  - **Sales tax excluded**: `Sales Tax Charged to Buyer` column is intentionally ignored — Mercari remits sales tax automatically, same policy as Etsy.
  - **Expenses** (if > 0 each): `Seller Shipping Fee` → "Shipping Costs", `Mercari Selling Fee` → "Mercari Selling Fees", `Payment Processing Fee Charged To Seller` → "Payment Processing Fees", `Shipping Adjustment Fee` → "Shipping Costs", `Penalty Fee` → "Other Expense".
  - Skips: canceled orders (non-Completed status or non-empty Canceled Date), the "Totals:" summary row, and the "Report generated on:" footer row.
  - Date format: Mercari uses MM/DD/YYYY — converted via `mercariDateToIso()`.
  - Preview panel before import, same UX pattern as Etsy import.
  - Uses `parseCsvTable()`, `parseUsd()`, `postTaxIncomeEntry()`, `postTaxExpenseEntry()` — no new infrastructure.
- **"Mercari Selling Fees"** and **"Other Expense"** added to `DEFAULT_TAX_EXPENSE_CATEGORIES`.

### Stats system fix

- **Seeded years (2023, 2024, 2025)**: `getYearStats()` previously returned only hardcoded baseline data with no DB lookup. Now it also fetches from the DB and layers any imported records on top of the seeded baseline. This means Etsy or Mercari imports for those years now appear in Stats.
- **All-time card**: `buildAllTimeBusinessStats()` previously only fetched 2026 DB data. Now fetches DB records for 2023, 2024, 2025, and 2026 (post-cutover only for 2026) and adds them all on top of the all-time seeded baseline.
- **Expense categorization simplified**: the long vendor/category string-matching chain was replaced with an `else` fallback — any expense that isn't advertising/marketing, shipping, or supplies gets bucketed into platform fees. This makes Mercari fees (and any future platform) count correctly without needing to enumerate every vendor name.

### Key behavior note
The seeded baseline numbers for 2023–2025 represent all pre-admin historical sales. DB imports for those years add on top of (not replace) those baselines. Do not double-count by re-importing data that was already factored into the seeded totals.

---

## Session Update — 2026-03-31 (Item Stats, Accounting Fixes, Modal UX)

### Bug fixes

#### Manage Categories — deleted defaults reappearing on reload
- **Root cause**: `loadCategoryPrefs()` unconditionally re-added any missing default categories on every page load, undoing user deletions.
- **Fix**: Added `DELETED_DEFAULT_EXPENSE_KEYS` and `DELETED_DEFAULT_INCOME_KEYS` sets (persisted to `localStorage` as `esa_tax_expense_deleted_defaults` / `esa_tax_income_deleted_defaults`). The re-add loop now skips anything in those sets. Adding a category back removes it from the deleted set.

#### Item Stats not updating from imports
- **Root cause (Mercari)**: `detectItemStatEntry()` used strict consecutive-word substring matching (e.g. `"gohan hat"`). Mercari listing titles like `"Handmade Gohan Inspired Four Star Dragon Ball Baby Hat"` have words between key terms, so nothing matched.
- **Fix**: Added broader single-phrase keywords to each product — `"gohan inspired"`, `"four star dragon ball"`, `"luffy inspired"`, `"goku inspired"`, `"rumi inspired"`, `"trunks inspired"`, `"majin buu inspired"` etc.
- **Root cause (Etsy)**: Etsy statement CSV `Title` column for Sale rows contains the order ID (e.g. `"Order #1234567890"`), not the listing title. The income entry `source` field was set to this order ID, so `detectItemStatEntry` never matched.
- **Fix**: `previewEtsyStatementCsv()` now builds a `titleByOrder` Map by reading Transaction Fee rows, whose `Title` column is `"Transaction fee: [Listing Title]"`. The listing title is extracted and stored keyed by order ID (from the `Info` column). Sale rows look up their order ID in this map and use the listing title as `source`. The order ID is preserved in the `notes` field for audit trail.

#### Item Stats UI cleanup (2026-03-31)
- Removed per-size breakdown rows from Item Stats cards — size is not reliably captured from CSV titles.
- Removed "Total Products Sold" summary row from the Item Stats card.

#### Expense journal offset for Etsy/Mercari fees posting to Owner Contributions
- **Root cause**: `buildExpenseJournalEntry()` in `worker.js` defaults the offset account to `3100` (Owner Contributions) when `paid_via` doesn't match known payment methods. Etsy imports set `paid_via = 'etsy'` and Mercari imports set `paid_via = 'mercari'` — neither matched `stripe`, `cash`, `checking`, or `bank`, so all their fees were incorrectly crediting Owner Contributions.
- **Fix**: Added `'etsy'` and `'mercari'` to the Cash (1000) branch of the `paid_via` check. These fees are deducted from marketplace payouts (cash-equivalent). After deploying, run **Rebuild Auto Journal** in Accounts tab to repost all entries correctly.

### How Owner Contributions (3100) gets populated
Three sources post to Owner Contributions:
1. **Owner Transfer** (`personal_to_business` or `personal_paid_business_card` type) — via Add Owner Transfer modal. These go directly to journal entries and do NOT appear in the income ledger.
2. **Owner-funded income entries** — income rows where `is_owner_funded = 1`, OR category contains "owner funded"/"non-revenue", OR source contains the word "test". These DO appear in the income ledger but are excluded from all revenue/stats calculations and post to 3100 instead of 4000.
3. **Expense default fallback** — any expense where `paid_via` is blank or unrecognized still falls through to Owner Contributions. Keep `paid_via` filled in (use "cash", "bank", "card", "etsy", "mercari", "stripe", "business card") to avoid this.

### How Item Stats work
- `buildAllTimeItemStats()` fetches all 2026 income rows (category = "Product Sale", date ≥ 2026-03-18) from the DB and runs `detectItemStatEntry()` on each row's `source` and `notes` fields combined.
- `detectItemStatEntry()` does case-insensitive substring matching against keyword lists per product. Keyword lists are intentionally broad (e.g. `"gohan inspired"`, not just `"gohan hat"`) to handle varying title formats across platforms.
- The hardcoded `ITEM_STATS_BASELINE` in `admin.html` contains all pre-LLC-cutover historical counts. DB counts are added on top.
- **Mercari imports**: `source` is set to the full `Item Title` column — detection works automatically.
- **Etsy imports**: `source` is set to the listing title extracted from the Transaction Fee row for that order ID. This only works for imports made after the 2026-03-31 fix. Entries imported before that fix will have an order ID as source and won't match.
- Size tracking was removed — CSV titles are too inconsistently formatted to reliably capture size.

### Tax Ledger UX — modal conversion
Add Expense, Add Sale, Import Etsy Sales, Import Mercari Sales, and Add Income were converted from inline collapsible panels to branded modals (same pattern as Add Owner Transfer and Manage Categories). Modal IDs: `add-expense-modal`, `add-sale-modal`, `import-etsy-modal`, `import-mercari-modal`, `add-income-modal`. The `setTaxEntryMode()` function was removed; each button now calls its own `open*Modal()` function directly.

### Etsy CSV import — how listing titles are captured
The Etsy payment account statement CSV has one row per line item type per order. For Sale rows, the `Title` column only contains the order ID. Transaction Fee rows for the same order contain `"Transaction fee: [Listing Title]"` in the `Title` column and the order ID in the `Info` column. The importer builds an order ID → listing title map from fee rows, then assigns the listing title to the matching sale's income entry `source` field. Multi-item orders join titles with ` + `.

### Key operational notes
- After any worker.js change that affects journal logic, run **Rebuild Auto Journal** (Accounts tab) to repost all auto journal entries.
- Etsy and Mercari expense entries are identified for bulk operations by `paid_via = 'etsy'` / `paid_via = 'mercari'` respectively.
- The Etsy statement CSV is the payment account export (monthly), NOT the orders export. The orders export is not needed — listing titles come from Transaction Fee rows in the statement CSV.

---

## 2026-07-14 Update (Partial July Etsy Import)

A partial July 2026 Etsy statement (1-12 July) was imported before month end. Rows from it are marked `JULY_ETSY_PARTIAL_CUTOFF_2026_07_12` in the `notes` column of `tax_income` / `tax_expenses`. The Admin Import Etsy Sales preview skips transactions that already exist (commit `f1ee9b4`), so always import a full-month CSV through that preview rather than directly. The specific order IDs, label IDs and totals are kept out of this public repo (they are in Claude's local project memory, `july-2026-etsy-partial-import`).

---

## 2026-10-06 Update (Product Pages, Generated Shop, Google Merchant Readiness)

### Why

The February SEO pass predates the on-site shop. Listings had no URLs of their own (they lived in `shopleftcolumn.html`, loaded by XHR and shown in `href="#"` modals), so Google had nothing to list as a product and Merchant Center had nothing to accept.

### How the shop works now

- **`products.json` (repo root) is the single source of truth** for every listing: title, slug, `itemName` (sent to Stripe/Worker; do not change casually), category, sizes + prices + Stripe price IDs, images, description HTML, colour, plus site-wide handling times, shipping and the return policy.
- **`python3 scripts/build_shop.py`** regenerates everything below. Never hand-edit these:
  - the shop grid + hidden modal blocks + JSON-LD in `index.html` (between `SHOP:START/END` and `JSONLD:START/END` markers; the rest of `index.html` is hand-written)
  - `products/<slug>.html` — one page per visible listing (uses `<base href="/">` so the shared includes resolve)
  - `crochet-baby-sets.html`, `crochet-baby-hats.html`, `crochet-patterns.html`
  - `shipping-returns.html`; `privacy.html` and `terms.html` (static copies of the `footer.html` modals, which stay the source)
  - `sitemap.xml` (pages + product images) and `merchant-feed.xml` (Google Merchant Center)
- A generated file's `Last Updated` date only changes when its content changes, so rebuilding is always safe.
- `shopleftcolumn.html` was deleted. Shop/product styles moved from an inline `<style>` in `index.html` to `shop.css`.
- `"hidden": true` on a product removes it from the site, sitemap and feed but keeps its price IDs in the checkout allowlist.
- Product photos are self-hosted in `images/products/<slug>-N.jpg` (max 1500px) with `<slug>-thumb.jpg` (240px) for grids. Nothing is hotlinked from Etsy any more.

### Adding or changing a listing

1. Edit `products.json` (copy an existing product; add photos to `images/products/`).
2. Run `python3 scripts/build_shop.py`.
3. New Stripe price IDs: update `STORE_ALLOWED_PRICE_IDS` before pushing (see the `fmg-etsy-price-match` skill, which now edits `products.json`).
4. Update the footer date, commit the JSON and all generated files together.

### SEO / structured data

- Each product page has its own title, meta description, canonical, Open Graph image, a single H1, and `ProductGroup` JSON-LD with one variant + `Offer` per size (price, InStock, free US shipping, handling + transit time, 30-day return policy) plus `BreadcrumbList`. Each size has its own URL: `products/<slug>.html?size=3-6-months` (preselected by `initProductPage()` in `shop.js`).
- Homepage has `OnlineStore` + `ItemList` JSON-LD. The logo in `header.html` is no longer an `<h1>`/`<h2>` (`.site-title` / `.site-subtitle`), so each page's real heading is the only H1.
- No star-rating markup: Google does not allow marking up Etsy reviews as the site's own.

### Policies (as given by Red, 2026-10-06)

- **Returns**: within 30 days, mailed back to Florence Mae Gifts, LLC, PO Box 317, Parsonsburg, MD 21849; buyer pays return shipping; refund after the item is received and inspected.
- **Handling**: 10–15 business days for orders through 31 Oct 2026 (Halloween rush), then the standard 5–7 business days; ships USPS Ground Advantage, free, US only.
- `site.handlingTimes` in `products.json` holds both windows. **Rebuild on or after 1 Nov 2026** so the structured data and feed switch to 5–7 days (the on-page text already states both). For future seasonal rushes, add a window with a `through` date.

### Merchant Center

- Only products with `"merchantFeed": true` are in `merchant-feed.xml`. Started with the non-character items (Shadow Monster hat, Monster set, Santa set, Turtles set) because trademarked character names risk disapproval or account suspension. Pattern PDFs are excluded.
- Feed URL once deployed: `https://www.florencemaegifts.com/merchant-feed.xml`.
- Account-side steps (Search Console verification, Merchant Center account, shipping/returns settings, scheduled feed fetch) are done by Red, not in this repo.

### Cleanup (same day)

- `shop.html` (Gallery Archive) is now `noindex, follow`, retitled "Gallery of Past Creations", has its own H1 with a link back to the shop, and is no longer in `sitemap.xml`. This stops it competing with the homepage for shop keywords.
- This repo is public and GitHub Pages serves every tracked file (`.nojekyll`), including this one. Never put order IDs, customer details, financial totals or infrastructure IDs in any tracked file; keep them in Claude's local project memory instead.
- **Never delete, rename, redirect or edit `google3d348162492de5b6.html`** (repo root). It is the Google Search Console ownership verification file (method "HTML file", confirmed in the console on 2026-10-06), and the Merchant Center website claim depends on it. It has no header comment on purpose: Google needs its contents unchanged. `scripts/build_shop.py` refuses to run if it is missing.
- Google setup done 2026-10-06 by Red: Search Console URL-prefix property verified, `sitemap.xml` submitted (Success, 34 pages at the time); Merchant Center account "Florence Mae Gifts" claims the site and fetches `merchant-feed.xml` daily for free listings. Its return policy settings mirror `site.returns` in `products.json` (30 days, by mail, customer pays, no restocking fee, new condition only, no exchanges, refund within 7 business days); change both together.

## 2026-10-07 Update (Search Console structured data emails)

- Two Search Console emails arrived for this site; neither needed a code change.
- **Merchant listings, "Missing field description" (8 items):** from a crawl before commit `c404b38`, which added a description to every size variant. Checked live on 2026-10-07: all 23 product pages have a description on the `ProductGroup` and on each variant. "Validate fix" was started in Search Console that day (passed the quick initial check; Google emails the result).
- **Product snippets, "Missing field aggregateRating" / "Missing field review":** optional fields, left out on purpose (see "No star-rating markup" above). Do not add them and do not press "Validate fix" on them; it would fail.
- If `scripts/build_shop.py` changes, keep the variant-level `description` in the generated JSON-LD or the first warning comes back.

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
- **No build tools** — Zero-build project, no npm/webpack/bundler
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

## Footer Update

The `footer.html` contains a visible "Last Updated" date that should be updated whenever site content changes. This is separate from the header comment `Last Updated` field.

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
- Local helper files used for mapping were intentionally kept uncommitted:
  - `.stripe-price-map.json`
  - `.stripe-size-price-map.json`

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

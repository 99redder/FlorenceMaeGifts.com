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

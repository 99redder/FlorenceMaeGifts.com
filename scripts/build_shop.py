#!/usr/bin/env python3
"""Build the Florence Mae Gifts shop from products.json.

Run from anywhere:  python3 scripts/build_shop.py

products.json is the single source of truth for listings, prices, Stripe price
IDs, images, handling time and the return policy. This script regenerates:

  index.html              shop grid + modal detail blocks + JSON-LD (between markers)
  products/<slug>.html    one crawlable page per visible listing
  crochet-baby-hats.html, crochet-baby-sets.html, crochet-patterns.html
  shipping-returns.html   shipping + return policy
  privacy.html, terms.html  static copies of the footer modals (footer.html stays the source)
  sitemap.xml             pages + product images
  merchant-feed.xml       Google Merchant Center feed (products with "merchantFeed": true)

Never hand-edit the generated files. A file's "Last Updated" header date only
changes when its content changes, so rebuilding is always safe.
"""
import html
import json
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TODAY = date.today()
CREATED = '6 October 2026'
CSS_VERSION = '20261006'

CATEGORIES = {
    'baby-sets': {
        'file': 'crochet-baby-sets.html',
        'tab': 'Crochet Baby Sets',
        'name': 'Crochet Baby Sets',
        'h1': 'Handmade Crochet Baby Diaper Cover & Photo Sets',
        'title': 'Crochet Baby Diaper Cover Sets & Cosplay Photo Sets | Florence Mae Gifts',
        'description': 'Handmade crochet baby diaper cover sets and cosplay photo sets, including Dragon Ball Z inspired '
                       'baby costumes. Made to order in newborn to 12 month sizes with free U.S. shipping.',
        'intro': 'Crochet diaper cover sets, onesie sets and character-inspired baby cosplay sets, each one made to order '
                 'by hand. They are designed for newborn and milestone photos, first Halloween costumes, and baby shower '
                 'gifts for new parents.',
        'googleCategory': 'Apparel & Accessories > Clothing > Baby & Toddler Clothing > Baby & Toddler Outfits',
    },
    'hats': {
        'file': 'crochet-baby-hats.html',
        'tab': 'Crochet Hats',
        'name': 'Crochet Hats',
        'h1': 'Handmade Crochet Baby Hats & Beanies',
        'title': 'Handmade Crochet Baby Hats & Beanies | Florence Mae Gifts',
        'description': 'Handmade crochet baby hats and beanies, including Dragon Ball Z inspired designs. Made to order '
                       'in newborn through adult sizes with free U.S. shipping.',
        'intro': 'Soft, stretchy crochet hats and beanies made to order by hand. Most designs come in sizes from newborn '
                 'to 18 months, and several go up to youth and adult so the whole family can match.',
        'googleCategory': 'Apparel & Accessories > Clothing Accessories > Baby & Toddler Clothing Accessories > '
                          'Baby & Toddler Hats',
    },
    'patterns': {
        'file': 'crochet-patterns.html',
        'tab': 'Crochet Patterns',
        'name': 'Crochet Patterns',
        'h1': 'Crochet Baby Hat Patterns (PDF Download)',
        'title': 'Beginner Crochet Baby Hat Patterns (PDF) | Florence Mae Gifts',
        'description': 'Beginner-level crochet baby hat pattern PDFs from Florence Mae Gifts. Download and make the '
                       'same hats sold in the shop.',
        'intro': 'Prefer to make it yourself? These beginner-level crochet pattern PDFs walk you through the same hat '
                 'designs sold in the shop. Patterns are digital downloads; no finished hat or supplies are included.',
        'googleCategory': 'Arts & Entertainment > Hobbies & Creative Arts > Arts & Crafts > Craft Patterns & Molds',
    },
}
CATEGORY_ORDER = ['baby-sets', 'hats', 'patterns']


# ---------- helpers ----------

def esc(text):
    return html.escape(str(text), quote=True)


def long_date(d):
    return '%d %s' % (d.day, d.strftime('%B %Y'))


def money(value):
    return '$%s' % value


def size_slug(label):
    return re.sub(r'[^a-z0-9]+', '-', label.lower()).strip('-')


def strip_tags(markup):
    text = re.sub(r'<(br|/p|/li|/ul)[^>]*>', ' ', markup)
    text = re.sub(r'<[^>]+>', '', text)
    return re.sub(r'\s+', ' ', html.unescape(text)).strip()


def jsonld(data):
    body = json.dumps(data, indent=2, ensure_ascii=False).replace('</', '<\\/')
    return '<script type="application/ld+json">\n%s\n</script>' % body


DATE_LINE = re.compile(r'(; Last Updated: )[^\n]*')
LASTMOD = {}


def write_page(rel_path, content):
    """Write a generated file; keep the old Last Updated date if nothing else changed."""
    path = ROOT / rel_path
    stamped = DATE_LINE.sub(lambda m: m.group(1) + long_date(TODAY), content, count=1)
    when = TODAY
    if path.exists():
        old = path.read_text()
        if DATE_LINE.sub(r'\1', old, count=1) == DATE_LINE.sub(r'\1', content, count=1):
            stamped = old
            m = DATE_LINE.search(old)
            try:
                from datetime import datetime
                when = datetime.strptime(m.group(0).split(': ', 1)[1].strip(), '%d %B %Y').date()
            except (AttributeError, ValueError):
                when = TODAY
    if not path.exists() or path.read_text() != stamped:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(stamped)
        print('wrote  ', rel_path)
    LASTMOD[rel_path] = when


# ---------- product model ----------

class Shop:
    def __init__(self, data):
        self.site = data['site']
        self.safety = data['safety']
        self.base = self.site['baseUrl'].rstrip('/')
        self.all_products = data['products']
        self.products = [p for p in self.all_products if not p.get('hidden')]
        self.validate()

    def validate(self):
        seen_ids, seen_slugs = set(), set()
        for p in self.all_products:
            for key in ('id', 'slug', 'title', 'itemName', 'category', 'images', 'detailsHtml'):
                if not p.get(key):
                    sys.exit('products.json: %s is missing "%s"' % (p.get('id', '?'), key))
            if p['id'] in seen_ids or p['slug'] in seen_slugs:
                sys.exit('products.json: duplicate id or slug on %s' % p['id'])
            seen_ids.add(p['id'])
            seen_slugs.add(p['slug'])
            if p['category'] not in CATEGORIES:
                sys.exit('products.json: %s has unknown category %s' % (p['id'], p['category']))
            tiers = p.get('sizes') or [{'price': p.get('price'), 'priceId': p.get('priceId')}]
            for t in tiers:
                if not re.fullmatch(r'\d+\.\d{2}', str(t.get('price'))) or not str(t.get('priceId', '')).startswith('price_'):
                    sys.exit('products.json: %s has a bad price or priceId: %r' % (p['id'], t))
            for img in p['images']:
                if not (ROOT / img['src']).exists():
                    sys.exit('products.json: %s image not found: %s' % (p['id'], img['src']))

    # handling time ---------------------------------------------------
    def handling_windows(self):
        """Handling windows that still apply today (expired seasonal ones are dropped)."""
        live = [w for w in self.site['handlingTimes'] if not w.get('through') or w['through'] >= TODAY.isoformat()]
        return live or self.site['handlingTimes'][-1:]

    def handling_now(self):
        return self.handling_windows()[0]

    def handling_short(self):
        w = self.handling_now()
        text = 'Made to order: ships in %d–%d business days' % (w['minDays'], w['maxDays'])
        if w.get('through'):
            d = date.fromisoformat(w['through'])
            text += ' (orders placed through %s %d)' % (d.strftime('%b'), d.day)
        return text

    def handling_sentences(self):
        return ['%s: %d–%d business days to make.' % (w['label'], w['minDays'], w['maxDays'])
                for w in self.handling_windows()]

    # product accessors -----------------------------------------------
    def url(self, p):
        return '%s/products/%s.html' % (self.base, p['slug'])

    def rel(self, p):
        return 'products/%s.html' % p['slug']

    def thumb(self, p):
        return 'images/products/%s-thumb.jpg' % p['slug']

    def base_name(self, p):
        return re.sub(r'\s*\((Multiple Sizes Available|PDF Download Only)\)', '', p['title']).strip()

    def seo_name(self, p):
        if p.get('seoName'):
            return p['seoName']
        name = self.base_name(p)
        return ('Handmade ' if 'crochet' in name.lower() else 'Handmade Crochet ') + name

    def tiers(self, p):
        return p.get('sizes') or [{'label': None, 'price': p['price'], 'priceId': p['priceId']}]

    def price_label(self, p):
        first = self.tiers(p)[0]['price']
        return ('Starting at %s USD' if p.get('sizes') else '%s USD') % money(first)

    def meta_description(self, p):
        if p.get('metaDescription'):
            return p['metaDescription']
        name = self.seo_name(p)
        if p.get('digital'):
            return ('%s from Florence Mae Gifts. Beginner-level crochet pattern, %s. Digital PDF download; '
                    'no physical item ships.' % (name, money(p['price'])))
        sizes = p['sizes']
        gift = ' A photo-ready baby shower gift.' if p['category'] == 'baby-sets' else ''
        return ('%s, made to order by Florence Mae Gifts. %d sizes (%s to %s) from %s with free U.S. shipping.%s'
                % (name, len(sizes), sizes[0]['label'], sizes[-1]['label'], money(sizes[0]['price']), gift))

    def plain_description(self, p):
        text = strip_tags(p['detailsHtml'])
        if p.get('digital'):
            return text
        return '%s Handmade to order by Florence Mae Gifts in Maryland. Free U.S. shipping.' % text


# ---------- structured data ----------

def shipping_details(shop):
    ship, w = shop.site['shipping'], shop.handling_now()
    return {
        '@type': 'OfferShippingDetails',
        'shippingRate': {'@type': 'MonetaryAmount', 'value': ship['cost'], 'currency': 'USD'},
        'shippingDestination': {'@type': 'DefinedRegion', 'addressCountry': ship['country']},
        'deliveryTime': {
            '@type': 'ShippingDeliveryTime',
            'handlingTime': {'@type': 'QuantitativeValue', 'minValue': w['minDays'], 'maxValue': w['maxDays'], 'unitCode': 'DAY'},
            'transitTime': {'@type': 'QuantitativeValue', 'minValue': ship['transitMinDays'], 'maxValue': ship['transitMaxDays'], 'unitCode': 'DAY'},
        },
    }


def return_policy(shop, digital=False):
    if digital:
        return {'@type': 'MerchantReturnPolicy', 'applicableCountry': 'US',
                'returnPolicyCategory': 'https://schema.org/MerchantReturnNotPermitted'}
    r = shop.site['returns']
    return {
        '@type': 'MerchantReturnPolicy',
        'applicableCountry': 'US',
        'returnPolicyCategory': 'https://schema.org/MerchantReturnFiniteReturnWindow',
        'merchantReturnDays': r['days'],
        'returnMethod': 'https://schema.org/ReturnByMail',
        'returnFees': 'https://schema.org/ReturnFeesCustomerResponsibility',
        'returnLabelSource': 'https://schema.org/ReturnLabelCustomerResponsibility',
        'itemCondition': 'https://schema.org/NewCondition',
        'refundType': 'https://schema.org/FullRefund',
        'restockingFee': {'@type': 'MonetaryAmount', 'value': 0, 'currency': 'USD'},
        'merchantReturnLink': '%s/shipping-returns.html' % shop.base,
    }


def offer(shop, p, tier):
    url = shop.url(p)
    if tier['label']:
        url += '?size=' + size_slug(tier['label'])
    data = {
        '@type': 'Offer',
        'url': url,
        'priceCurrency': 'USD',
        'price': tier['price'],
        'availability': 'https://schema.org/InStock',
        'itemCondition': 'https://schema.org/NewCondition',
        'seller': {'@type': 'Organization', 'name': shop.site['brand']},
        'hasMerchantReturnPolicy': return_policy(shop, p.get('digital')),
    }
    if not p.get('digital'):
        data['shippingDetails'] = shipping_details(shop)
    return data


def product_jsonld(shop, p):
    images = ['%s/%s' % (shop.base, i['src']) for i in p['images']]
    common = {
        'description': shop.plain_description(p),
        'image': images,
        'brand': {'@type': 'Brand', 'name': shop.site['brand']},
        'category': CATEGORIES[p['category']]['googleCategory'],
    }
    if p.get('color'):
        common['color'] = p['color']
    if p.get('sizes'):
        variants = []
        for tier in p['sizes']:
            variants.append({
                '@type': 'Product',
                'sku': '%s-%s' % (p['id'], size_slug(tier['label'])),
                'name': '%s - %s' % (shop.seo_name(p), tier['label']),
                'description': '%s Size: %s.' % (shop.plain_description(p), tier['label']),
                'size': tier['label'],
                'image': images[0],
                'offers': offer(shop, p, tier),
            })
        return dict({'@context': 'https://schema.org', '@type': 'ProductGroup', 'name': shop.seo_name(p),
                     'url': shop.url(p), 'productGroupID': p['id'], 'variesBy': ['https://schema.org/size'],
                     'hasVariant': variants}, **common)
    return dict({'@context': 'https://schema.org', '@type': 'Product', 'name': shop.seo_name(p), 'url': shop.url(p),
                 'sku': p['id'], 'offers': offer(shop, p, shop.tiers(p)[0])}, **common)


def breadcrumb_jsonld(shop, crumbs):
    return {'@context': 'https://schema.org', '@type': 'BreadcrumbList', 'itemListElement': [
        {'@type': 'ListItem', 'position': i + 1, 'name': name, 'item': '%s/%s' % (shop.base, path)}
        for i, (name, path) in enumerate(crumbs)]}


def itemlist_jsonld(shop, products, name):
    return {'@context': 'https://schema.org', '@type': 'ItemList', 'name': name, 'itemListElement': [
        {'@type': 'ListItem', 'position': i + 1, 'url': shop.url(p), 'name': shop.seo_name(p)}
        for i, p in enumerate(products)]}


def store_jsonld(shop):
    lines = shop.site['returns']['addressLines']
    return {
        '@context': 'https://schema.org',
        '@type': 'OnlineStore',
        '@id': shop.base + '/#store',
        'name': shop.site['brand'],
        'legalName': shop.site['legalName'],
        'url': shop.base + '/',
        'logo': shop.base + '/images/favicon.png',
        'image': shop.base + '/' + shop.products[0]['images'][0]['src'],
        'description': 'Handmade crochet baby hats, diaper cover sets, cosplay photo sets and crochet patterns, '
                       'made to order in Maryland.',
        'address': {'@type': 'PostalAddress', 'streetAddress': lines[1], 'addressLocality': 'Parsonsburg',
                    'addressRegion': 'MD', 'postalCode': '21849', 'addressCountry': 'US'},
        'sameAs': ['https://www.etsy.com/shop/florencemaegifts', 'https://www.instagram.com/florencemaegifts/'],
        'hasMerchantReturnPolicy': return_policy(shop),
    }


# ---------- shared markup ----------

def file_header(name, description):
    return ('<!----\n  ======================================\n; Title: %s\n; Author: Red\n; Date Created: %s\n'
            '; Last Updated: %s\n; Description: %s (generated by scripts/build_shop.py - do not hand-edit)\n'
            '; Sources Used: W3 Schools CSS Template https://www.w3schools.com/css/css_templates.asp\n'
            ';=====================================\n----->\n' % (name, CREATED, long_date(TODAY), description))


def page(shop, rel_path, title, description, body, header_desc, *, image=None, og_type='website', ld=(), nested=False):
    canonical = '%s/%s' % (shop.base, rel_path)
    image = image or '%s/%s' % (shop.base, shop.products[0]['images'][0]['src'])
    base_tag = '  <base href="/">\n' if nested else ''
    ld_blocks = '\n'.join('  ' + jsonld(block).replace('\n', '\n  ') for block in ld)
    return '''%(header)s

<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
%(base_tag)s  <title>%(title)s</title>
  <meta name="description" content="%(description)s">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <link rel="canonical" href="%(canonical)s">
  <meta property="og:site_name" content="Florence Mae Gifts">
  <meta property="og:title" content="%(title)s">
  <meta property="og:description" content="%(description)s">
  <meta property="og:type" content="%(og_type)s">
  <meta property="og:url" content="%(canonical)s">
  <meta property="og:image" content="%(image)s">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="%(title)s">
  <meta name="twitter:description" content="%(description)s">
  <meta name="twitter:image" content="%(image)s">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="script-src 'self'; object-src 'none';">

  <!--Fonts-->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Lora&family=Varela+Round&display=swap" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Sofia+Sans+Extra+Condensed:wght@100&display=swap" rel="stylesheet">

  <!--Style Sheets-->
  <link href="fmg.css?v=%(css)s" type="text/css" rel="stylesheet">
  <link href="logo-font/logo-font.css" type="text/css" rel="stylesheet">
  <link href="fontawesome-fallback.css" type="text/css" rel="stylesheet">
  <link href="shop.css?v=%(css)s" type="text/css" rel="stylesheet">

  <!--Favorites Icon-->
  <link rel="icon" href="images/favicon.png">
  <script src="includeHTML.js" defer></script>
  <script src="site.js" defer></script>
  <script src="footer.js" defer></script>
  <script src="shop.js?v=%(css)s" defer></script>

%(ld)s
</head>

<body class="light-theme">

<i id="icon-mode" class="fa fa-toggle-off pull-right" style="font-size: 20px;" role="button" tabindex="0" aria-label="Toggle color theme"><span id="icon-text" class="toggle"></span></i><br><br>

<div w3-include-html="header.html" class="header"></div>

<div w3-include-html="topnav.html" class="topnav"></div>

<main id="main-content" role="main">
<div class="row">

  <div class="leftcolumn">
%(body)s
  </div>

  <div w3-include-html="rightcolumn.html" class="rightcolumn hidden-mobile"></div>

</div>
</main>

<div w3-include-html="footer.html" class="stuff-centered"></div>
</body>
</html>
''' % {'header': file_header(rel_path.split('/')[-1], header_desc), 'base_tag': base_tag, 'title': esc(title),
       'description': esc(description), 'canonical': canonical, 'og_type': og_type, 'image': image,
       'css': CSS_VERSION, 'ld': ld_blocks, 'body': body}


def breadcrumb_html(crumbs):
    items = []
    for i, (name, path) in enumerate(crumbs):
        if i == len(crumbs) - 1:
            items.append('<li aria-current="page">%s</li>' % esc(name))
        else:
            items.append('<li><a href="%s">%s</a></li>' % (path or './', esc(name)))
    return '<nav class="breadcrumb" aria-label="Breadcrumb"><ol>%s</ol></nav>' % ''.join(items)


def card_html(shop, p, modal=False, indent=' '):
    """One row in a listing grid. With modal=True the link also opens the index.html modal."""
    attrs = ' data-category="%s"' % p['category']
    if modal and p.get('added'):
        attrs += ' data-added="%s"' % p['added']
    link_attrs = ' class="open-listing-modal" data-modal-target="%s"' % p['id'] if modal else ''
    badge = '\n%s<div class="digital-item-badge">Digital Item Only</div>' % indent if p.get('digital') else ''
    return ('<div class="shop-listing"%(attrs)s>\n'
            '%(i)s<img src="%(thumb)s" class="shop-thumb" width="88" height="88" loading="lazy" alt="%(alt)s">\n'
            '%(i)s<div>\n'
            '%(i)s <a href="%(href)s"%(link)s>%(title)s</a>\n'
            '%(i)s <p><strong>%(price)s</strong></p>\n'
            '%(i)s</div>%(badge)s\n'
            '</div>') % {'attrs': attrs, 'i': indent, 'thumb': shop.thumb(p), 'alt': esc(shop.seo_name(p)),
                         'href': shop.rel(p), 'link': link_attrs, 'title': esc(p['title']),
                         'price': shop.price_label(p), 'badge': badge}


def buy_row_html(shop, p):
    tiers = shop.tiers(p)
    attrs = 'data-item-name="%s" data-price-id="%s" data-price-display="%s USD"' % (
        esc(p['itemName']), tiers[0]['priceId'], money(tiers[0]['price']))
    if p.get('sizes'):
        size_map = {'%s (%s)' % (t['label'], money(t['price'])): t['priceId'] for t in p['sizes']}
        attrs += ' data-size-price-map="%s"' % esc(json.dumps(size_map, separators=(',', ':')))
    if p.get('digital'):
        return ('<p><span class="listing-free-shipping-badge" aria-label="PDF Download">PDF Download</span>'
                '<button class="start-stripe-order" %s>Buy Now</button>'
                '<span class="listing-us-only-note">Digital PDF download — no physical shipping</span></p>' % attrs)
    return ('<p><span class="listing-free-shipping-badge" aria-label="Free Shipping">Free U.S. Shipping</span>'
            '<button class="start-stripe-order" %s>Buy Now</button>'
            '<span class="listing-us-only-note">Ships to all 50 U.S. States<br>No International Shipping Available</span>'
            '<span class="listing-handling-note">%s</span></p>' % (attrs, esc(shop.handling_short())))


def gallery_html(p, name, lazy, indent):
    first = p['images'][0]
    main = ('<img src="%s" class="listing-main-image" width="%d" height="%d"%s alt="%s">'
            % (first['src'], first['width'], first['height'],
               ' loading="lazy"' if lazy else ' fetchpriority="high"', esc(name)))
    thumbs = '\n'.join(
        '%s <img src="%s" class="listing-gallery-thumb" loading="lazy" alt="%s photo %d" data-full-src="%s">'
        % (indent, img['src'], esc(name), n, img['src']) for n, img in enumerate(p['images'], 1))
    out = '%s<div class="listing-main-image-wrap">\n%s %s\n%s</div>' % (indent, indent, main, indent)
    if len(p['images']) > 1:
        out += '\n%s<div class="listing-image-gallery">\n%s\n%s</div>' % (indent, thumbs, indent)
    return out


def modal_block_html(shop, p):
    """Hidden detail block that index.html copies into the listing modal."""
    name = shop.base_name(p)
    parts = [
        '<div class="shop-listing-details" id="%s" style="display:none;">' % p['id'],
        ' <h3>%s</h3>' % esc(p['title']),
        ' <p><strong>Price:</strong> %s</p>' % shop.price_label(p),
        gallery_html(p, name, True, ' '),
        ' <div class="listing-details-summary">\n  <h4>Listing details</h4>\n%s\n </div>' % p['detailsHtml'],
    ]
    if p.get('safety'):
        parts.append(' <p>Safety &amp; Use Information: %s</p>' % shop.safety[p['safety']])
    if p.get('etsyUrl'):
        parts.append(' <p><a href="%s#reviews" target="resource window" rel="noopener noreferrer">Read Etsy reviews for this item</a></p>' % p['etsyUrl'])
    parts.append(' <p><a class="listing-full-page-link" href="%s">View full details page</a></p>' % shop.rel(p))
    parts.append(' ' + buy_row_html(shop, p))
    parts.append('</div>')
    return '\n'.join(parts)


# ---------- pages ----------

def build_index(shop):
    path = ROOT / 'index.html'
    src = path.read_text()
    tabs = ['<div class="shop-category-tabs" role="tablist" aria-label="Shop categories">',
            ' <button type="button" class="shop-category-tab active" data-category="all">All items</button>']
    tabs += [' <button type="button" class="shop-category-tab" data-category="%s">%s</button>' % (c, CATEGORIES[c]['tab'])
             for c in CATEGORY_ORDER]
    tabs += ['</div>',
             '<p class="shop-category-links">Browse by category: ' + ' | '.join(
                 '<a href="%s">%s</a>' % (CATEGORIES[c]['file'], CATEGORIES[c]['name']) for c in CATEGORY_ORDER) + '</p>']
    listings = '\n\n'.join(card_html(shop, p, modal=True) + '\n\n' + modal_block_html(shop, p) for p in shop.products)
    grid = '\n'.join(tabs) + '\n\n' + listings
    ld = '\n'.join('  ' + jsonld(b).replace('\n', '\n  ') for b in (
        store_jsonld(shop), itemlist_jsonld(shop, shop.products, 'Florence Mae Gifts shop')))

    def fill(text, name, payload):
        pattern = re.compile(r'(<!-- %s:START[^>]*-->).*?([ \t]*<!-- %s:END -->)' % (name, name), re.S)
        if not pattern.search(text):
            sys.exit('index.html is missing the %s:START / %s:END markers' % (name, name))
        return pattern.sub(lambda m: m.group(1) + '\n' + payload + '\n' + m.group(2), text)

    out = fill(fill(src, 'SHOP', grid), 'JSONLD', ld)
    write_page('index.html', out)


def product_page(shop, p):
    cat = CATEGORIES[p['category']]
    name = shop.base_name(p)
    crumbs = [('Shop', ''), (cat['name'], cat['file']), (name, shop.rel(p))]
    b = ['    ' + breadcrumb_html(crumbs),
         '    <article class="shop-listing-details product-detail" data-product-id="%s">' % p['id'],
         '     <h1 class="product-title">%s</h1>' % esc(shop.seo_name(p)),
         '     <p><strong>Price:</strong> %s</p>' % shop.price_label(p),
         gallery_html(p, name, False, '     '),
         '     ' + buy_row_html(shop, p),
         '     <h2 class="page-h2">Details</h2>',
         '     <div class="listing-details-summary">\n%s\n     </div>' % p['detailsHtml']]
    if p.get('sizes'):
        rows = ''.join('<tr><td>%s</td><td>%s</td></tr>' % (esc(t['label']), money(t['price'])) for t in p['sizes'])
        b.append('     <h2 class="page-h2">Sizes &amp; pricing</h2>\n'
                 '     <table class="product-size-table"><thead><tr><th>Size</th><th>Price</th></tr></thead>'
                 '<tbody>%s</tbody></table>' % rows)
    b.append('     <h2 class="page-h2">Shipping &amp; returns</h2>')
    if p.get('digital'):
        b.append('     <p>This is a digital PDF crochet pattern. A download link is emailed to you right after checkout; '
                 'no physical item ships. Because the file is delivered instantly, digital patterns cannot be returned. '
                 'See the <a href="shipping-returns.html">shipping &amp; returns policy</a>.</p>')
    else:
        ship = shop.site['shipping']
        b.append('     <p>Every piece is handmade to order. %s Orders then ship free by %s (about %d–%d business days '
                 'in transit) to all 50 U.S. states. International shipping is not available.</p>'
                 % (' '.join(esc(s) for s in shop.handling_sentences()), esc(ship['carrier']),
                    ship['transitMinDays'], ship['transitMaxDays']))
        ret = shop.site['returns']
        b.append('     <p>Returns are accepted within %d days for items that are new and unused. The buyer pays return '
                 'shipping, there is no restocking fee, and the refund is issued to your original payment method within '
                 '%d business days of the returned item arriving. We do not offer exchanges. See the full '
                 '<a href="shipping-returns.html">shipping &amp; returns policy</a>.</p>'
                 % (ret['days'], ret['refundBusinessDays']))
    if p.get('safety'):
        b.append('     <h2 class="page-h2">Safety &amp; use</h2>\n     <p>%s</p>' % shop.safety[p['safety']])
    if p.get('etsyUrl'):
        b.append('     <p><a href="%s#reviews" target="resource window" rel="noopener noreferrer">Read Etsy reviews for this item</a></p>' % p['etsyUrl'])
    b.append('    </article>')

    same = [q for q in shop.products if q['category'] == p['category'] and q['id'] != p['id']]
    idx = [q['id'] for q in shop.products if q['category'] == p['category']].index(p['id'])
    related = (same[idx:] + same[:idx])[:4]
    if related:
        b.append('    <section class="related-products">\n     <h2 class="page-h2">More %s</h2>' % esc(cat['name'].lower()))
        b += [card_html(shop, q, indent='      ').replace('<div class="shop-listing"', '     <div class="shop-listing"', 1)
              .replace('\n</div>', '\n     </div>') for q in related]
        b.append('     <p><a href="%s">See all %s</a></p>\n    </section>' % (cat['file'], esc(cat['name'].lower())))

    title = '%s | Florence Mae Gifts' % shop.seo_name(p)
    return page(shop, shop.rel(p), title, shop.meta_description(p), '\n'.join(b),
                'Product page for %s' % p['title'], image='%s/%s' % (shop.base, p['images'][0]['src']),
                og_type='product', ld=[product_jsonld(shop, p), breadcrumb_jsonld(shop, crumbs)], nested=True)


def category_page(shop, key):
    cat = CATEGORIES[key]
    items = [p for p in shop.products if p['category'] == key]
    crumbs = [('Shop', ''), (cat['name'], cat['file'])]
    others = ' | '.join('<a href="%s">%s</a>' % (CATEGORIES[c]['file'], CATEGORIES[c]['name'])
                        for c in CATEGORY_ORDER if c != key)
    body = ['    ' + breadcrumb_html(crumbs),
            '    <h1 class="page-title">%s</h1>' % esc(cat['h1']),
            '    <p>%s</p>' % esc(cat['intro'])]
    if key != 'patterns':
        body.append('    <p>%s Free U.S. shipping on every order. <a href="shipping-returns.html">Shipping &amp; returns</a>.</p>'
                    % esc(shop.handling_short() + '.'))
    body += [card_html(shop, p, indent='     ').replace('<div class="shop-listing"', '    <div class="shop-listing"', 1)
             .replace('\n</div>', '\n    </div>') for p in items]
    body.append('    <p>Also in the shop: %s | <a href="./">All items</a></p>' % others)
    return page(shop, cat['file'], cat['title'], cat['description'], '\n'.join(body),
                'Category page: %s' % cat['name'], image='%s/%s' % (shop.base, items[0]['images'][0]['src']),
                ld=[itemlist_jsonld(shop, items, cat['h1']), breadcrumb_jsonld(shop, crumbs)])


def shipping_returns_page(shop):
    ship, ret = shop.site['shipping'], shop.site['returns']
    address = '<br>'.join(esc(line) for line in ret['addressLines'])
    handling = ''.join('<li>%s</li>' % esc(s) for s in shop.handling_sentences())
    body = '''    <article class="policy-page">
     <h1 class="page-title">Shipping &amp; Returns</h1>

     <h2 class="page-h2">Processing time</h2>
     <p>Every Florence Mae Gifts item is handmade to order, so there is a make time before your order ships:</p>
     <ul>%(handling)s</ul>

     <h2 class="page-h2">Shipping</h2>
     <ul>
      <li>Shipping is <strong>free</strong> on every physical item.</li>
      <li>Orders ship by %(carrier)s, which usually takes %(tmin)d–%(tmax)d business days in transit.</li>
      <li>We ship to all 50 U.S. states. International shipping is not available.</li>
      <li>Crochet pattern PDFs are digital: a download link is emailed right after checkout and nothing is mailed.</li>
     </ul>

     <h2 class="page-h2">Returns &amp; refunds</h2>
     <ul>
      <li>Returns are accepted within <strong>%(days)d days</strong> of delivery.</li>
      <li><strong>Condition:</strong> items must be returned new and unused to be eligible for a refund.</li>
      <li>Returns are by mail. Send the item back to the address it was shipped from:</li>
     </ul>
     <address>%(address)s</address>
     <ul>
      <li><strong>Return shipping:</strong> the buyer pays return shipping. We do not provide a return label.</li>
      <li><strong>Restocking fee:</strong> none.</li>
      <li><strong>Refund timing:</strong> once the item arrives it is inspected, and your refund is issued to the original payment method within %(refund)d business days of the returned item arriving.</li>
      <li><strong>Exchanges:</strong> we do not offer exchanges. To get a different size or item, return the original for a refund and place a new order.</li>
      <li>Digital pattern PDFs are delivered instantly and cannot be returned. If there is a problem with your file, contact us and we will make it right.</li>
     </ul>

     <h2 class="page-h2">Questions</h2>
     <p>Need help with an order, a size, or a return? <a href="#modal-contact" data-open-modal="modal-contact">Send us a message</a> and we will get back to you.</p>
    </article>''' % {'handling': handling, 'carrier': esc(ship['carrier']), 'tmin': ship['transitMinDays'],
                     'tmax': ship['transitMaxDays'], 'days': ret['days'], 'refund': ret['refundBusinessDays'], 'address': address}
    return page(shop, 'shipping-returns.html', 'Shipping & Returns | Florence Mae Gifts',
                'Florence Mae Gifts shipping and return policy: free U.S. shipping, made-to-order processing times, '
                'and 30-day returns on new, unused items.', body, 'Shipping and return policy')


def legal_page(shop, modal_id, rel_path, title, description):
    """Static copy of a footer.html modal so the policy has a real, crawlable URL."""
    footer = (ROOT / 'footer.html').read_text()
    m = re.search(r'<div id="%s" class="footer-modal">\s*<div class="footer-modal-content">\s*<span[^>]*>.*?</span>\s*'
                  r'<h3[^>]*>(.*?)</h3>(.*?)\n\s*</div>\s*</div>' % modal_id, footer, re.S)
    if not m:
        sys.exit('footer.html: could not find #%s' % modal_id)
    content = re.sub(r'\n[ \t]+', '\n     ', m.group(2).strip())
    body = '    <article class="policy-page">\n     <h1 class="page-title">%s</h1>\n     %s\n    </article>' % (
        m.group(1).strip(), content)
    return page(shop, rel_path, title, description, body, 'Static page copy of the footer %s modal' % modal_id)


# ---------- sitemap + merchant feed ----------

def build_sitemap(shop):
    def entry(rel, changefreq, priority, images=()):
        loc = shop.base + '/' + ('' if rel == 'index.html' else rel)
        when = LASTMOD.get(rel)
        lines = ['  <url>', '    <loc>%s</loc>' % loc]
        if when:
            lines.append('    <lastmod>%s</lastmod>' % when.isoformat())
        lines += ['    <changefreq>%s</changefreq>' % changefreq, '    <priority>%s</priority>' % priority]
        lines += ['    <image:image><image:loc>%s/%s</image:loc></image:image>' % (shop.base, i['src']) for i in images]
        return '\n'.join(lines + ['  </url>'])

    urls = [entry('index.html', 'weekly', '1.0')]
    urls += [entry(CATEGORIES[c]['file'], 'weekly', '0.8') for c in CATEGORY_ORDER]
    urls += [entry(shop.rel(p), 'weekly', '0.9', p['images']) for p in shop.products]
    urls += [entry('about.html', 'monthly', '0.6'), entry('reviews.html', 'monthly', '0.6'),
             entry('shipping-returns.html', 'monthly', '0.5'),
             entry('privacy.html', 'yearly', '0.2'), entry('terms.html', 'yearly', '0.2'),
             entry('disclaimers.html', 'yearly', '0.2')]
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '
           'xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n%s\n</urlset>\n' % '\n'.join(urls))
    path = ROOT / 'sitemap.xml'
    if not path.exists() or path.read_text() != xml:
        path.write_text(xml)
        print('wrote   sitemap.xml')


def age_group(label):
    label = label.lower()
    if 'adult' in label:
        return 'adult'
    if 'youth' in label:
        return 'kids'
    m = re.match(r'(\d+)-(\d+) months', label)
    if not m:
        return 'infant'
    low = int(m.group(1))
    return 'newborn' if low < 3 else 'infant' if low < 12 else 'toddler'


def build_feed(shop):
    w, ship = shop.handling_now(), shop.site['shipping']
    items = []
    for p in shop.products:
        if not p.get('merchantFeed') or p.get('digital'):
            continue
        extra = ''.join('      <g:additional_image_link>%s/%s</g:additional_image_link>\n' % (shop.base, i['src'])
                        for i in p['images'][1:10])
        for tier in p['sizes']:
            slug = size_slug(tier['label'])
            items.append('''    <item>
      <g:id>%(id)s-%(slug)s</g:id>
      <g:item_group_id>%(id)s</g:item_group_id>
      <g:title>%(title)s</g:title>
      <g:description>%(desc)s</g:description>
      <g:link>%(url)s?size=%(slug)s</g:link>
      <g:image_link>%(base)s/%(image)s</g:image_link>
%(extra)s      <g:availability>in_stock</g:availability>
      <g:price>%(price)s USD</g:price>
      <g:condition>new</g:condition>
      <g:brand>%(brand)s</g:brand>
      <g:identifier_exists>no</g:identifier_exists>
      <g:google_product_category>%(gcat)s</g:google_product_category>
      <g:product_type>%(ptype)s</g:product_type>
      <g:size>%(size)s</g:size>
      <g:color>%(color)s</g:color>
      <g:age_group>%(age)s</g:age_group>
      <g:gender>unisex</g:gender>
      <g:min_handling_time>%(hmin)d</g:min_handling_time>
      <g:max_handling_time>%(hmax)d</g:max_handling_time>
      <g:shipping>
        <g:country>US</g:country>
        <g:service>%(carrier)s</g:service>
        <g:price>%(shipcost)s USD</g:price>
      </g:shipping>
    </item>''' % {'id': p['id'], 'slug': slug, 'title': esc('%s - %s' % (shop.seo_name(p), tier['label'])),
                  'desc': esc(shop.plain_description(p)), 'url': shop.url(p), 'base': shop.base,
                  'image': p['images'][0]['src'], 'extra': extra, 'price': tier['price'],
                  'brand': esc(shop.site['brand']), 'gcat': esc(CATEGORIES[p['category']]['googleCategory']),
                  'ptype': esc('Handmade Crochet > ' + CATEGORIES[p['category']]['name']), 'size': esc(tier['label']),
                  'color': esc(p.get('color', 'Multicolor')), 'age': age_group(tier['label']),
                  'hmin': w['minDays'], 'hmax': w['maxDays'], 'carrier': esc(ship['carrier']), 'shipcost': ship['cost']})
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n'
           '  <channel>\n    <title>Florence Mae Gifts</title>\n    <link>%s/</link>\n'
           '    <description>Handmade crochet baby hats and diaper cover sets</description>\n%s\n  </channel>\n</rss>\n'
           % (shop.base, '\n'.join(items)))
    path = ROOT / 'merchant-feed.xml'
    if not path.exists() or path.read_text() != xml:
        path.write_text(xml)
        print('wrote   merchant-feed.xml')
    return len(items)


# Google Search Console verifies ownership with this file, and the Merchant Center
# website claim depends on it. It must stay at the site root, unchanged.
GOOGLE_VERIFICATION_FILE = 'google3d348162492de5b6.html'


def main():
    shop = Shop(json.loads((ROOT / 'products.json').read_text()))
    if not (ROOT / GOOGLE_VERIFICATION_FILE).exists():
        sys.exit('%s is missing from the repo root. Restore it (git checkout) before deploying: without it '
                 'Search Console ownership and the Merchant Center claim are lost.' % GOOGLE_VERIFICATION_FILE)
    build_index(shop)
    for p in shop.products:
        write_page(shop.rel(p), product_page(shop, p))
    keep = {p['slug'] + '.html' for p in shop.products}
    for stale in (ROOT / 'products').glob('*.html'):
        if stale.name not in keep:
            stale.unlink()
            print('removed products/%s (listing hidden or deleted)' % stale.name)
    for key in CATEGORY_ORDER:
        write_page(CATEGORIES[key]['file'], category_page(shop, key))
    write_page('shipping-returns.html', shipping_returns_page(shop))
    write_page('privacy.html', legal_page(shop, 'modal-privacy', 'privacy.html', 'Privacy Policy | Florence Mae Gifts',
                                          'Florence Mae Gifts privacy policy.'))
    write_page('terms.html', legal_page(shop, 'modal-terms', 'terms.html', 'Terms of Use | Florence Mae Gifts',
                                        'Florence Mae Gifts website terms of use.'))
    for static in ('about.html', 'reviews.html', 'disclaimers.html'):
        m = DATE_LINE.search((ROOT / static).read_text())
        try:
            from datetime import datetime
            LASTMOD[static] = datetime.strptime(m.group(0).split(': ', 1)[1].strip(), '%d %B %Y').date()
        except (AttributeError, ValueError):
            pass
    build_sitemap(shop)
    feed_items = build_feed(shop)
    print('%d visible listings, %d hidden, %d merchant feed items. Handling now: %s'
          % (len(shop.products), len(shop.all_products) - len(shop.products), feed_items, shop.handling_short()))


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Sales map on reviews.html: where Florence Mae Gifts' Etsy orders have shipped.

sales-map.json (repo root) is the source: order counts per town or city, made from
Etsy's order CSVs by scripts/import_etsy_orders.py. It never holds names, street
addresses, ZIP codes, order IDs or money, because this repo is public.

scripts/build_shop.py calls section_html() to put the map, stats and place table
into reviews.html (inside the REVIEWS markers, above the shop button). While
sales-map.json has no places the section is left out of the page.

scripts/geo/basemap.json holds the country and state outlines, already projected
with world_xy() and us_xy() below; scripts/geo/make_basemap.py rebuilds it from
Natural Earth. Dots are projected here at build time with the same functions.

Preview the section with made-up places (writes sales-map-preview.html, git-ignored):
  python3 scripts/sales_map.py --preview
"""
import html
import json
import math
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'sales-map.json'
BASEMAP = ROOT / 'scripts' / 'geo' / 'basemap.json'
SAMPLE = ROOT / 'scripts' / 'geo' / 'sample-sales-map.json'
PREVIEW = ROOT / 'sales-map-preview.html'

HOME = {'label': 'Salisbury, Maryland', 'lat': 38.3607, 'lon': -75.5994}

# Shading classes per view; the colours live in reviews.css (--sm-c1 .. --sm-c5).
MAX_CLASSES = 5
NICE_BREAKS = [1, 2, 3, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000]


def esc(text):
    return html.escape(str(text), quote=True)


# ---------- projections ----------
# The same maths as d3-geo's geoNaturalEarth1 and geoAlbersUsa, so the outlines in
# basemap.json and the dots drawn on top of them line up.

WORLD_WIDTH = 960
WORLD_SCALE = WORLD_WIDTH / (2 * math.pi * 0.8707)


def world_xy(lon, lat):
    lam, phi = math.radians(lon), math.radians(lat)
    phi2 = phi * phi
    phi4 = phi2 * phi2
    x = lam * (0.8707 - 0.131979 * phi2 + phi4 * (-0.013791 + phi4 * (0.003971 * phi2 - 0.001529 * phi4)))
    y = phi * (1.007226 + phi2 * (0.015085 + phi4 * (-0.044475 + 0.028874 * phi2 - 0.005916 * phi4)))
    return WORLD_WIDTH / 2 + WORLD_SCALE * x, -WORLD_SCALE * y


def _conic_equal_area(rotate, center, parallels, scale, translate):
    sy0 = math.sin(math.radians(parallels[0]))
    n = (sy0 + math.sin(math.radians(parallels[1]))) / 2
    c = 1 + sy0 * (2 * n - sy0)
    r0 = math.sqrt(c) / n

    def raw(lam, phi):
        r = math.sqrt(c - 2 * n * math.sin(phi)) / n
        return r * math.sin(lam * n), r0 - r * math.cos(lam * n)

    cx, cy = raw(math.radians(center[0]), math.radians(center[1]))
    tx, ty = translate

    def project(lon, lat):
        lam = math.radians((lon + rotate + 180) % 360 - 180)
        x, y = raw(lam, math.radians(lat))
        return tx + scale * (x - cx), ty - scale * (y - cy)
    return project


US_SCALE, US_X, US_Y = 1070, 480, 250
_LOWER48 = _conic_equal_area(96, (-0.6, 38.7), (29.5, 45.5), US_SCALE, (US_X, US_Y))
_ALASKA = _conic_equal_area(154, (-2, 58.5), (55, 65), US_SCALE * 0.35,
                            (US_X - 0.307 * US_SCALE, US_Y + 0.201 * US_SCALE))
_HAWAII = _conic_equal_area(157, (-3, 19.9), (8, 18), US_SCALE,
                            (US_X - 0.205 * US_SCALE, US_Y + 0.212 * US_SCALE))


def us_xy(lon, lat, state):
    """Albers USA with Alaska and Hawaii moved below the lower 48. None outside the 50 states + DC."""
    if state == 'AK':
        return _ALASKA(lon, lat)
    if state == 'HI':
        return _HAWAII(lon, lat)
    if state in US_STATES:
        return _LOWER48(lon, lat)
    return None


US_STATES = {
    'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas', 'CA': 'California', 'CO': 'Colorado',
    'CT': 'Connecticut', 'DE': 'Delaware', 'DC': 'Washington, D.C.', 'FL': 'Florida', 'GA': 'Georgia',
    'HI': 'Hawaii', 'ID': 'Idaho', 'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa', 'KS': 'Kansas',
    'KY': 'Kentucky', 'LA': 'Louisiana', 'ME': 'Maine', 'MD': 'Maryland', 'MA': 'Massachusetts',
    'MI': 'Michigan', 'MN': 'Minnesota', 'MS': 'Mississippi', 'MO': 'Missouri', 'MT': 'Montana',
    'NE': 'Nebraska', 'NV': 'Nevada', 'NH': 'New Hampshire', 'NJ': 'New Jersey', 'NM': 'New Mexico',
    'NY': 'New York', 'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio', 'OK': 'Oklahoma',
    'OR': 'Oregon', 'PA': 'Pennsylvania', 'RI': 'Rhode Island', 'SC': 'South Carolina', 'SD': 'South Dakota',
    'TN': 'Tennessee', 'TX': 'Texas', 'UT': 'Utah', 'VT': 'Vermont', 'VA': 'Virginia', 'WA': 'Washington',
    'WV': 'West Virginia', 'WI': 'Wisconsin', 'WY': 'Wyoming',
}


def miles_between(a_lat, a_lon, b_lat, b_lon):
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 3958.8 * 2 * math.asin(math.sqrt(h))


# ---------- data ----------

def load_basemap():
    return json.loads(BASEMAP.read_text())


def load_data(path=DATA):
    if not path.exists():
        return {'places': []}
    return json.loads(path.read_text())


def class_breaks(values):
    """Lower bounds of up to MAX_CLASSES shading classes, spread evenly on a log scale."""
    top = max(values)
    if top <= MAX_CLASSES:
        return list(range(1, top + 1))
    breaks = [1]
    for i in range(1, MAX_CLASSES):
        target = top ** (i / MAX_CLASSES)
        nice = min(NICE_BREAKS, key=lambda b: abs(math.log(b) - math.log(target)))
        if nice > breaks[-1] and nice <= top:
            breaks.append(nice)
    return breaks


def class_of(value, breaks):
    return sum(1 for b in breaks if value >= b)


def class_labels(breaks, top):
    """'1', '2–4', '5+' style legend labels; the last class is open-ended."""
    labels = []
    for i, low in enumerate(breaks):
        last = i + 1 == len(breaks)
        high = top if last else breaks[i + 1] - 1
        if high == low:
            labels.append(str(low))
        elif last:
            labels.append('%d+' % low)
        else:
            labels.append('%d–%d' % (low, high))
    return labels


def orders_text(n):
    return '%s order%s' % ('{:,}'.format(n), '' if n == 1 else 's')


def month_year(ym):
    y, m = (int(v) for v in ym.split('-')[:2])
    return date(y, m, 1).strftime('%B %Y')


def long_us_date(iso):
    d = date.fromisoformat(iso)
    return '%s %d, %d' % (d.strftime('%B'), d.day, d.year)


class Summary:
    """Everything the section shows, worked out once from sales-map.json."""

    def __init__(self, data, basemap):
        self.countries = {c['id']: c for c in basemap['world']['countries']}
        self.places = [p for p in data.get('places', []) if p.get('orders', 0) > 0]
        for p in self.places:
            if p['country'] not in self.countries:
                sys.exit('sales-map.json: unknown country code %r (use the codes in scripts/geo/basemap.json)'
                         % p['country'])
        self.total = sum(p['orders'] for p in self.places)
        self.by_country = {}
        self.by_state = {}
        self.by_continent = {}
        for p in self.places:
            self.by_country[p['country']] = self.by_country.get(p['country'], 0) + p['orders']
            continent = self.countries[p['country']]['continent']
            self.by_continent[continent] = self.by_continent.get(continent, 0) + p['orders']
            if p['country'] == 'US' and p.get('region') in US_STATES:
                self.by_state[p['region']] = self.by_state.get(p['region'], 0) + p['orders']
        self.us_total = self.by_country.get('US', 0)
        self.abroad = self.total - self.us_total
        self.states = len([s for s in self.by_state if s != 'DC'])
        self.towns = len([p for p in self.places if p.get('city')])
        self.mapped = [p for p in self.places if p.get('lat') is not None and p.get('lon') is not None]
        self.farthest = max(self.mapped, key=lambda p: miles_between(HOME['lat'], HOME['lon'], p['lat'], p['lon']),
                            default=None)

    def country_name(self, code):
        return self.countries[code]['name']

    def place_label(self, p):
        if p['country'] == 'US':
            if p.get('region') == 'DC':
                return US_STATES['DC']
            region = US_STATES.get(p.get('region'), p.get('region') or '')
            return ', '.join(v for v in (p.get('city'), region) if v) or 'United States'
        return ', '.join(v for v in (p.get('city'), self.country_name(p['country'])) if v)


# ---------- SVG ----------

def num(v):
    s = '%.1f' % v
    s = s.rstrip('0').rstrip('.') if '.' in s else s
    return '0' if s in ('-0', '') else s


def dot_radius(orders):
    return min(18.0, 4.0 + 2.0 * math.sqrt(orders - 1))


HEART = 'M0,3.6C-1.2,2.4-5,0-5,-2.6C-5,-4.6-3.6,-5.6-2.3,-5.6C-1.2,-5.6-.4,-4.9,0,-4.1C.4,-4.9 1.2,-5.6 2.3,-5.6' \
        'C3.6,-5.6 5,-4.6 5,-2.6C5,0 1.2,2.4 0,3.6Z'


def dot_html(x, y, orders, label, indent):
    r = dot_radius(orders)
    tip = '%s: %s' % (label, orders_text(orders))
    return ('%s<circle class="sm-dot" cx="%s" cy="%s" r="%s" data-r="%s" data-label="%s" data-orders="%d">'
            '<title>%s</title></circle>' % (indent, num(x), num(y), num(r), num(r), esc(label), orders, esc(tip)))


def home_html(x, y, indent):
    return ('%s<g class="sm-home" transform="translate(%s %s) scale(1.6)" data-label="Our home: %s">'
            '<title>Our home: %s</title><path d="%s"/></g>'
            % (indent, num(x), num(y), esc(HOME['label']), esc(HOME['label']), HEART))


def map_svg(view_id, title, desc, view_box, shapes, counts, names, dots, home, breaks, tops=None):
    """shapes: [{'id', 'd'}]; counts/names keyed by shape id; dots: [(x, y, orders, label)];
    tops: optional {shape id: (note, x, y)}, the busiest town, shown in the readout and marked while hovered."""
    out = ['     <svg class="sales-map-svg" viewBox="%s" role="img" aria-labelledby="%s-title %s-desc" '
           'focusable="false">' % (view_box, view_id, view_id),
           '      <title id="%s-title">%s</title>' % (view_id, esc(title)),
           '      <desc id="%s-desc">%s</desc>' % (view_id, esc(desc)),
           '      <g class="sm-shapes">']
    for s in shapes:
        if not s['d']:
            continue  # too small to draw at this scale; its dots still show
        n = counts.get(s['id'], 0)
        if n:
            tip = '%s: %s' % (names[s['id']], orders_text(n))
            extra = ''
            if tops and s['id'] in tops:
                note, tx, ty = tops[s['id']]
                tip += '. ' + note
                extra = ' data-top="%s" data-tx="%s" data-ty="%s"' % (esc(note), num(tx), num(ty))
            out.append('       <path class="sm-c%d" d="%s" data-label="%s" data-orders="%d"%s><title>%s</title></path>'
                       % (class_of(n, breaks), s['d'], esc(names[s['id']]), n, extra, esc(tip)))
        else:
            out.append('       <path d="%s"/>' % s['d'])
    out.append('      </g>')
    if dots:
        out.append('      <g class="sm-dots">')
    # Biggest first, so a small town next to a big city stays on top and reachable.
    for x, y, orders, label in sorted(dots, key=lambda d: (-d[2], d[3])):
        out.append(dot_html(x, y, orders, label, '       '))
    if dots:
        out.append('      </g>')
    if home:
        out.append(home_html(home[0], home[1], '      '))
    out.append('     </svg>')
    return out


def legend_html(caption, breaks, top, dots=True):
    out = ['     <figcaption class="sales-map-legend">',
           '      <span class="sales-map-legend-scale"><span class="sales-map-legend-title">%s</span>' % esc(caption)]
    for i, label in enumerate(class_labels(breaks, top), 1):
        out.append('       <span class="sales-map-legend-step"><span class="sales-map-swatch sm-c%d"></span>%s</span>'
                   % (i, esc(label)))
    out.append('      </span>')
    if dots:
        out.append('      <span class="sales-map-legend-item"><svg class="sales-map-legend-icon" viewBox="-12 -12 24 24" '
                   'aria-hidden="true"><circle class="sm-dot" r="6"/></svg>'
                   'A town or city (bigger dot, more orders)</span>')
    out += ['      <span class="sales-map-legend-item"><svg class="sales-map-legend-icon" viewBox="-12 -12 24 24" '
            'aria-hidden="true"><g class="sm-home" transform="scale(1.6)"><path d="%s"/></g></svg>Our home in %s</span>'
            % (HEART, esc(HOME['label'])),
            '     </figcaption>']
    return out


def world_figure(s, basemap):
    world = basemap['world']
    names = {code: c['name'] for code, c in s.countries.items()}
    dots = [world_xy(p['lon'], p['lat']) + (p['orders'], s.place_label(p)) for p in s.mapped]
    breaks = class_breaks(list(s.by_country.values()))
    desc = ('Countries are shaded by how many orders shipped there. ' +
            '; '.join('%s: %s' % (names[c], orders_text(n))
                      for c, n in sorted(s.by_country.items(), key=lambda kv: (-kv[1], names[kv[0]]))) + '.')
    out = ['    <figure class="sales-map-figure" id="sales-map-world">']
    out += map_svg('sales-map-world', 'World map of Florence Mae Gifts orders', desc, world['viewBox'],
                   world['countries'], s.by_country, names, dots, world_xy(HOME['lon'], HOME['lat']), breaks)
    out += legend_html('Orders per country', breaks, max(s.by_country.values()))
    out.append('    </figure>')
    return out


def us_figure(s, basemap):
    """States shaded by total orders; hovering a state names its busiest city (no dots)."""
    us = basemap['us']
    names = {code: US_STATES[code] for code in US_STATES}
    best = {}
    for p in s.mapped:
        st = p.get('region')
        if p['country'] == 'US' and st in US_STATES and p.get('city') and \
                (st not in best or (-p['orders'], p['city']) < (-best[st]['orders'], best[st]['city'])):
            best[st] = p
    tops = {}
    for st, p in best.items():
        xy = us_xy(p['lon'], p['lat'], st)
        if xy:
            tops[st] = ('Most orders: %s (%s)' % (p['city'], '{:,}'.format(p['orders'])),) + xy
    breaks = class_breaks(list(s.by_state.values()))
    desc = ('States are shaded by how many orders shipped there. ' +
            '; '.join('%s: %s' % (names[c], orders_text(n))
                      for c, n in sorted(s.by_state.items(), key=lambda kv: (-kv[1], names[kv[0]]))) + '.')
    out = ['    <figure class="sales-map-figure" id="sales-map-us">']
    out += map_svg('sales-map-us', 'Map of Florence Mae Gifts orders across the United States', desc, us['viewBox'],
                   us['states'], s.by_state, names, [], us_xy(HOME['lon'], HOME['lat'], 'MD'), breaks, tops)
    out += legend_html('Orders per state', breaks, max(s.by_state.values()), dots=False)
    out.append('    </figure>')
    return out


# ---------- section ----------

def stat_html(value, label):
    return ('     <div class="sales-map-stat"><span class="sales-map-stat-value">%s</span>'
            '<span class="sales-map-stat-label">%s</span></div>' % (value, label))


def bars_html(title, counts, name_of, limit, more_noun):
    """Top `limit` entries as bars, values at the tips, widths relative to the first. The rest go in one line below."""
    rows = sorted(((name_of(k), n) for k, n in counts.items()), key=lambda r: (-r[1], r[0]))
    shown, rest = rows[:limit], rows[limit:]
    top = shown[0][1]
    out = ['     <section class="sales-map-card">',
           '      <h3 class="sales-map-card-title">%s</h3>' % esc(title),
           '      <ol class="sales-map-bars">']
    for name, n in shown:
        out.append('       <li><span class="sales-map-bar-name">%s</span><span class="sales-map-bar-track">'
                   '<span class="sales-map-bar" style="width: max(4px, calc((100%% - 3.5em) * %s))"></span>'
                   '<span class="sales-map-bar-value">%s</span></span></li>'
                   % (esc(name), '%.3f' % (n / top), '{:,}'.format(n)))
    out.append('      </ol>')
    if rest:
        out.append('      <p class="sales-map-card-more">Plus %d more %s with %s.</p>'
                   % (len(rest), more_noun, orders_text(sum(n for _, n in rest))))
    out.append('     </section>')
    return out


def places_table(s):
    out = ['    <details class="sales-map-all">',
           '     <summary>See every place we have shipped to (%d)</summary>' % len(s.places),
           '     <table class="sales-map-table">',
           '      <caption>Etsy orders by town or city</caption>',
           '      <thead><tr><th scope="col">Place</th><th scope="col">Orders</th></tr></thead>']
    for code, total in sorted(s.by_country.items(), key=lambda kv: (-kv[1], s.country_name(kv[0]))):
        rows = [p for p in s.places if p['country'] == code]
        rows.sort(key=lambda p: (US_STATES.get(p.get('region'), p.get('region') or '') if code == 'US' else '',
                                 (p.get('city') or '').lower()))
        out.append('      <tbody>')
        out.append('       <tr class="sales-map-table-group"><th scope="rowgroup">%s</th><td>%s</td></tr>'
                   % (esc(s.country_name(code)), '{:,}'.format(total)))
        for p in rows:
            label = s.place_label(p)
            if p.get('lat') is None:
                label += ' (not on the map)'
            out.append('       <tr><td>%s</td><td>%d</td></tr>' % (esc(label), p['orders']))
        out.append('      </tbody>')
    out += ['     </table>', '    </details>']
    return out


def intro_text(s):
    parts = []
    if s.states:
        parts.append('%d state%s' % (s.states, '' if s.states == 1 else 's'))
    abroad = len([c for c in s.by_country if c != 'US'])
    if abroad:
        parts.append('%d other countr%s' % (abroad, 'y' if abroad == 1 else 'ies') if s.us_total
                     else '%d countr%s' % (abroad, 'y' if abroad == 1 else 'ies'))
    where = ' and '.join(parts) if parts else 'places near and far'
    text = ('Every dot is a town or city where an Etsy order from Florence Mae Gifts was shipped. From Megan\'s '
            'studio in %s, handmade hats and baby sets have gone to %s.' % (HOME['label'], where))
    if s.abroad and s.us_total:
        text += ' %s of %s (%d%%) went outside the United States.' % (
            '{:,}'.format(s.abroad), '{:,}'.format(s.total), round(100 * s.abroad / s.total))
    if s.abroad:
        # The site's own checkout is US-only (see shipping-returns.html); don't let the map suggest otherwise.
        text += ' Orders abroad came through our Etsy shop; checkout on this website ships within the U.S.'
    return text


def section_html(data, basemap, preview=False):
    """The sales map section for reviews.html, as a list of lines. Empty while there are no places."""
    s = Summary(data, basemap)
    if not s.total:
        return []
    out = ['    <section class="sales-map" aria-labelledby="sales-map-heading">',
           '    <h2 class="page-h2" id="sales-map-heading">Where our crochet has traveled</h2>']
    if preview:
        out.append('    <p class="sales-map-preview-note">Preview with made-up places. The real map is built from '
                   'sales-map.json.</p>')
    out.append('    <p class="sales-map-intro">%s</p>' % esc(intro_text(s)))
    out.append('    <div class="sales-map-stats">')
    out.append(stat_html('{:,}'.format(s.total), 'Orders shipped'))
    if s.states:
        out.append(stat_html(str(s.states), 'US state%s%s' % ('' if s.states == 1 else 's',
                                                           ' + D.C.' if 'DC' in s.by_state else '')))
    out.append(stat_html(str(len(s.by_country)), 'Countr%s' % ('y' if len(s.by_country) == 1 else 'ies')))
    if s.towns:
        out.append(stat_html('{:,}'.format(s.towns), 'Towns &amp; cities'))
    if s.farthest:
        miles = miles_between(HOME['lat'], HOME['lon'], s.farthest['lat'], s.farthest['lon'])
        out.append(stat_html('{:,}<small> mi</small>'.format(int(round(miles, -1))),
                             'Farthest, to %s' % esc(s.place_label(s.farthest))))
    out.append('    </div>')

    show_us = bool(s.by_state)
    out.append('    <div class="sales-map-views">')
    if show_us:
        out += ['     <input class="sales-map-radio" type="radio" name="sales-map-view" id="sales-map-view-world" checked>',
                '     <label class="sales-map-tab" for="sales-map-view-world">World</label>',
                '     <input class="sales-map-radio" type="radio" name="sales-map-view" id="sales-map-view-us">',
                '     <label class="sales-map-tab" for="sales-map-view-us">United States</label>']
    out += world_figure(s, basemap)
    if show_us:
        out += us_figure(s, basemap)
    out.append('    </div>')

    cards = []
    if len(s.by_country) > 1:
        cards += bars_html('Top countries', s.by_country, s.country_name, 6, 'countries')
    if len(s.by_state) > 1:
        cards += bars_html('Top states', s.by_state, US_STATES.get, 7, 'states')
    if len(s.by_continent) > 1:
        cards += bars_html('By continent', s.by_continent, str, 7, 'continents')
    if cards:
        out += ['    <div class="sales-map-cards">'] + cards + ['    </div>']

    out += places_table(s)
    note = []
    if data.get('firstOrder') and data.get('lastOrder'):
        note.append('Counts Etsy orders shipped from %s to %s' % (month_year(data['firstOrder']),
                                                                 month_year(data['lastOrder'])))
    else:
        note.append('Counts Etsy orders')
    if data.get('asOf'):
        note[-1] += ', updated %s' % long_us_date(data['asOf'])
    note[-1] += '.'
    note.append('Only the town or city is shown, never a name or address.')
    if data.get('ordersWithoutAddress'):
        n = data['ordersWithoutAddress']
        note.append('%s (pattern downloads) had no shipping address, so %s not counted.'
                    % (orders_text(n).capitalize(), 'it is' if n == 1 else 'they are'))
    out.append('    <p class="sales-map-asof">%s</p>' % esc(' '.join(note)))
    out.append('    </section>')
    out.append('')
    return out


# ---------- preview ----------

def write_preview():
    """reviews.html with the section built from made-up places, for checking the layout before real data exists."""
    page = (ROOT / 'reviews.html').read_text()
    marker = '    <p class="reviews-cta">'
    if marker not in page:
        sys.exit('reviews.html has no reviews-cta paragraph to put the preview above')
    start = page.find('    <section class="sales-map"')
    if start != -1:
        end = page.find('\n    </section>\n', start) + len('\n    </section>\n')
        page = page[:start] + page[end:].lstrip('\n')
    section = '\n'.join(section_html(json.loads(SAMPLE.read_text()), load_basemap(), preview=True))
    page = page.replace(marker, section + '\n' + marker, 1)
    page = page.replace('<meta name="robots" content="index, follow, max-image-preview:large">',
                        '<meta name="robots" content="noindex">')
    PREVIEW.write_text(page)
    print('wrote   %s (made-up places; git-ignored, never deployed)' % PREVIEW.name)


if __name__ == '__main__':
    if sys.argv[1:] == ['--preview']:
        write_preview()
    else:
        sys.exit(__doc__)

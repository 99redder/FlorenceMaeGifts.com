#!/usr/bin/env python3
"""Turn Etsy order CSVs into sales-map.json, the data behind the sales map on reviews.html.

  python3 scripts/import_etsy_orders.py            # every .csv in private/etsy-orders/
  python3 scripts/import_etsy_orders.py a.csv b.csv
  python3 scripts/build_shop.py                    # then rebuild reviews.html

Input: Etsy's own exports (Shop Manager > Settings > Options > Download Data,
"Orders" or "Order Items", one file per year), or any CSV with the columns
Order ID, Sale Date, Ship City, Ship State, Ship Zipcode, Ship Country (and
optionally Latitude, Longitude). Keep them in private/etsy-orders/, which is
git-ignored: they hold buyers' names and addresses and must never be committed.
Orders are counted once by Order ID across all files, so overlapping exports are
fine. Cancelled orders are skipped.

Output: sales-map.json holds only town or city, state or region, country,
rounded coordinates and an order count per place. No names, street addresses,
ZIP codes, order IDs or money.

Coordinates come from free public gazetteers, downloaded once into
private/geo-cache/: US ZIP code centroids and US place names from the Census
Bureau, and towns of 1,000+ people worldwide from GeoNames. A place that can't
be found keeps no coordinates: it is still counted, and listed in the place
table as "not on the map". Type its lat/lon into sales-map.json by hand; later
imports keep coordinates already there.
"""
import argparse
import csv
import io
import json
import re
import subprocess
import sys
import unicodedata
import urllib.request
import zipfile
from datetime import date, datetime
from pathlib import Path

import sales_map

ROOT = sales_map.ROOT
ORDERS_DIR = ROOT / 'private' / 'etsy-orders'
CACHE_DIR = ROOT / 'private' / 'geo-cache'

ZCTA_URL = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_zcta_national.zip'
PLACES_URL = 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_place_national.zip'
GEONAMES_URL = 'https://download.geonames.org/export/dump/cities1000.zip'

COLUMNS = {
    'order': ('order id', 'order_id', 'order number', 'order #', 'order'),
    'date': ('sale date', 'order date', 'date paid', 'date'),
    'city': ('ship city', 'city', 'town'),
    'state': ('ship state', 'state', 'province', 'region'),
    'zip': ('ship zipcode', 'ship zip', 'ship postal code', 'zipcode', 'zip', 'postal code', 'postcode'),
    'country': ('ship country', 'country'),
    'lat': ('latitude', 'lat'),
    'lon': ('longitude', 'lon', 'lng'),
    'status': ('status', 'order status'),
}

COUNTRY_ALIASES = {
    'us': 'US', 'usa': 'US', 'u s': 'US', 'u s a': 'US', 'united states': 'US', 'united states of america': 'US',
    'america': 'US', 'uk': 'GB', 'u k': 'GB', 'great britain': 'GB', 'britain': 'GB', 'england': 'GB',
    'scotland': 'GB', 'wales': 'GB', 'northern ireland': 'GB', 'korea south': 'KR', 'republic of korea': 'KR',
    'korea republic of': 'KR', 'russian federation': 'RU', 'turkiye': 'TR', 'viet nam': 'VN', 'holland': 'NL',
    'the netherlands': 'NL', 'czech republic': 'CZ', 'republic of ireland': 'IE', 'hong kong sar': 'HK',
    'macau': 'MO', 'the bahamas': 'BS', 'trinidad': 'TT', 'uae': 'AE',
}
# Buyer misspellings of a real town, fixed before counting: (country code, norm(city as typed)) -> correct name.
CITY_FIXES = {
    ('AU', 'rockview'): 'Rockyview',  # QLD, near Rockhampton; no Rockview exists there
}
US_TERRITORIES = {'PR': 'Puerto Rico', 'GU': 'Guam', 'VI': 'U.S. Virgin Islands', 'AS': 'American Samoa',
                  'MP': 'Northern Mariana Islands', 'AA': 'Armed Forces Americas', 'AE': 'Armed Forces Europe',
                  'AP': 'Armed Forces Pacific'}


# ---------- text ----------

def norm(text):
    """Loose match key for place names: no accents, case, punctuation; Saint -> st, Mount -> mt, Fort -> ft."""
    text = unicodedata.normalize('NFKD', text or '')
    text = ''.join(c for c in text if not unicodedata.combining(c)).lower().replace('&', ' and ')
    text = re.sub(r"[^a-z0-9]+", ' ', text.replace("'", ''))
    words = {'saint': 'st', 'sainte': 'ste', 'mount': 'mt', 'fort': 'ft'}
    words = [words.get(w, w) for w in text.split()]
    if words[:2] == ['city', 'of']:
        words = words[2:]
    return ' '.join(words)


def tidy_city(text):
    """Buyers type their own city: fix ALL CAPS / all lower, keep anything else as typed."""
    text = re.sub(r'\s+', ' ', (text or '').strip(' ,.'))
    if text.upper() in ('APO', 'FPO', 'DPO'):
        return text.upper()
    if text and (text.isupper() or text.islower()):
        text = text.title()
    return text


def parse_month(value):
    """'2026-10' from Etsy's 10/22/26, or the other usual date spellings; None if it can't be read."""
    value = (value or '').strip()
    for candidate in (value, value.split(' ')[0]):
        for fmt in ('%m/%d/%y', '%m/%d/%Y', '%Y-%m-%d', '%Y/%m/%d', '%B %d, %Y', '%b %d, %Y', '%d %B %Y'):
            try:
                d = datetime.strptime(candidate, fmt)
            except ValueError:
                continue
            return '%04d-%02d' % (d.year, d.month)
    return None


# ---------- reading the CSVs ----------

def column_map(header):
    found = {}
    lowered = [h.strip().lower() for h in header]
    for key, names in COLUMNS.items():
        for name in names:
            if name in lowered:
                found[key] = lowered.index(name)
                break
    return found


def read_orders(paths):
    """One dict per order (deduplicated by Order ID), plus counts of what was skipped."""
    orders, seen = [], set()
    skipped = {'duplicate': 0, 'cancelled': 0}
    for path in paths:
        with open(path, newline='', encoding='utf-8-sig') as f:
            rows = list(csv.reader(f))
        if not rows:
            continue
        cols = column_map(rows[0])
        if 'country' not in cols and 'city' not in cols:
            print('skipped %s: no Ship City or Ship Country column' % path.name)
            continue
        count = 0
        for row in rows[1:]:
            if not any(cell.strip() for cell in row):
                continue
            get = lambda key: row[cols[key]].strip() if key in cols and cols[key] < len(row) else ''  # noqa: E731
            if 'cancel' in get('status').lower():
                skipped['cancelled'] += 1
                continue
            order_id = get('order')
            if order_id:
                if order_id in seen:
                    skipped['duplicate'] += 1
                    continue
                seen.add(order_id)
            orders.append({k: get(k) for k in ('date', 'city', 'state', 'zip', 'country', 'lat', 'lon')})
            count += 1
        print('read    %s: %d orders' % (path.name, count))
    return orders, skipped


# ---------- places ----------

class Countries:
    def __init__(self, basemap):
        self.by_key = {}
        for c in basemap['world']['countries']:
            for name in [c['name'], c['id']] + c['aliases']:
                self.by_key.setdefault(norm(name), c['id'])
        for alias, code in COUNTRY_ALIASES.items():
            self.by_key[alias] = code
        self.ids = {c['id'] for c in basemap['world']['countries']}

    def code(self, text):
        return self.by_key.get(norm(text))


STATE_BY_NAME = {norm(name): code for code, name in sales_map.US_STATES.items()}
STATE_BY_NAME.update({norm(name): code for code, name in US_TERRITORIES.items()})
STATE_BY_NAME.update({'district of columbia': 'DC', 'washington dc': 'DC', 'washington d c': 'DC'})


def us_state(text):
    text = (text or '').strip()
    if text.upper() in sales_map.US_STATES or text.upper() in US_TERRITORIES:
        return text.upper()
    return STATE_BY_NAME.get(norm(text), text.upper())


def build_places(orders, countries):
    places, unknown, no_address = {}, {}, 0
    months = []
    for o in orders:
        month = parse_month(o['date'])
        country_text = o['country']
        code = countries.code(country_text) if country_text else None
        if not country_text and not o['city']:
            no_address += 1
            continue
        if not code:
            if not country_text and us_state(o['state']) in sales_map.US_STATES:
                code = 'US'
            else:
                unknown[country_text] = unknown.get(country_text, 0) + 1
                continue
        if month:
            months.append(month)
        city = tidy_city(o['city'])
        city = CITY_FIXES.get((code, norm(city)), city)
        if re.search(r'\d', city):
            # A number in the city field usually means part of a street address landed there. Never publish it.
            print('note    dropped a city value with digits in it (%s); counted under its state or country' % code)
            city = ''
        region = us_state(o['state']) if code == 'US' else o['state'].strip()
        key = (code, region if code == 'US' else '', norm(city))
        p = places.setdefault(key, {'country': code, 'region': region, 'spellings': {}, 'orders': 0,
                                    'zips': [], 'coords': []})
        p['orders'] += 1
        if city:
            p['spellings'][city] = p['spellings'].get(city, 0) + 1
        if code == 'US':
            z = re.sub(r'[^0-9]', '', o['zip'].split('-')[0])
            if 3 <= len(z) <= 5:
                p['zips'].append(z.zfill(5))
        try:
            p['coords'].append((float(o['lat']), float(o['lon'])))
        except ValueError:
            pass
    for p in places.values():
        p['city'] = max(sorted(p['spellings']), key=lambda s: p['spellings'][s]) if p['spellings'] else ''
    return list(places.values()), unknown, no_address, months


# ---------- gazetteers ----------

def download(url, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix('.part')
    where = dest.parent.relative_to(ROOT) if dest.parent.is_relative_to(ROOT) else dest.parent
    print('downloading %s (one time, saved in %s)' % (url, where))
    try:
        subprocess.run(['curl', '-fsSL', '--retry', '2', '-o', str(tmp), url], check=True)
    except (OSError, subprocess.CalledProcessError):
        with urllib.request.urlopen(url, timeout=120) as r, open(tmp, 'wb') as f:
            f.write(r.read())
    tmp.rename(dest)


def gazetteer(url, cache, offline):
    """Text of the one data file inside a cached zip, or None when it isn't available."""
    path = cache / url.rsplit('/', 1)[1]
    if not path.exists():
        if offline:
            return None
        try:
            download(url, path)
        except Exception as e:  # noqa: BLE001 - any failure just means no coordinates from this source
            print('warning could not download %s (%s); places that need it stay off the map' % (url, e))
            return None
    with zipfile.ZipFile(path) as z:
        name = next(n for n in z.namelist() if n.endswith('.txt'))
        raw = z.read(name)
    try:
        return raw.decode('utf-8')
    except UnicodeDecodeError:
        return raw.decode('latin-1')


def tsv(text):
    reader = csv.reader(io.StringIO(text), delimiter='\t')
    header = [h.strip() for h in next(reader)]
    for row in reader:
        yield dict(zip(header, (v.strip() for v in row)))


PLACE_SUFFIX = re.compile(r'\s+(city and borough|consolidated government|unified government|metropolitan government|'
                          r'metro government|urban county|municipality|borough|village|city|town|cdp|zona urbana|'
                          r'comunidad)$')


def us_lookups(text_zcta, text_places):
    zips, towns = {}, {}
    if text_zcta:
        for r in tsv(text_zcta):
            zips[r['GEOID']] = (float(r['INTPTLAT']), float(r['INTPTLONG']))
    if text_places:
        for r in tsv(text_places):
            name = norm(r['NAME'].replace('(balance)', ''))
            while PLACE_SUFFIX.search(name):
                name = PLACE_SUFFIX.sub('', name)
            key = (r['USPS'], name)
            land = float(r.get('ALAND') or 0)
            if key not in towns or land > towns[key][0]:
                towns[key] = (land, float(r['INTPTLAT']), float(r['INTPTLONG']))
    return zips, towns


def world_lookup(text, countries_needed):
    best = {}
    if not text:
        return best
    for line in text.splitlines():
        f = line.split('\t')
        if len(f) < 15 or f[8] not in countries_needed:
            continue
        pop = int(f[14] or 0)
        for name in {f[1], f[2], *f[3].split(',')}:
            key = (f[8], norm(name))
            if key[1] and (key not in best or pop > best[key][0]):
                best[key] = (pop, float(f[4]), float(f[5]))
    return best


def mean(coords):
    return (sum(c[0] for c in coords) / len(coords), sum(c[1] for c in coords) / len(coords))


def locate(places, previous, cache, offline):
    us_needed = any(p['country'] == 'US' for p in places)
    zips, towns = us_lookups(gazetteer(ZCTA_URL, cache, offline) if us_needed else None,
                             gazetteer(PLACES_URL, cache, offline) if us_needed else None)
    abroad = {p['country'] for p in places if p['country'] != 'US' and p['city']}
    world = world_lookup(gazetteer(GEONAMES_URL, cache, offline) if abroad else None, abroad)
    for p in places:
        key = place_key(p)
        found = None
        if key in previous:
            found = previous[key]
        elif p['coords']:
            found = mean(p['coords'])
        elif p['city'] and p['country'] == 'US':
            hits = [zips[z] for z in p['zips'] if z in zips]
            if hits:
                found = mean(hits)
            elif (p['region'], norm(p['city'])) in towns:
                found = towns[(p['region'], norm(p['city']))][1:]
        elif p['city'] and (p['country'], norm(p['city'])) in world:
            found = world[(p['country'], norm(p['city']))][1:]
        p['lat'], p['lon'] = (round(found[0], 2), round(found[1], 2)) if found else (None, None)


def place_key(p):
    return (p['country'], p['region'] if p['country'] == 'US' else '', norm(p['city']))


# ---------- output ----------

def write_json(path, data):
    """Indented, with one place per line so diffs stay readable."""
    places = data.pop('places')
    head = json.dumps(data, indent=2, ensure_ascii=False)[:-2]
    rows = [json.dumps(p, ensure_ascii=False) for p in places]
    body = ',\n    '.join(rows)
    path.write_text(head + ',\n  "places": [' + ('\n    ' + body + '\n  ' if rows else '') + ']\n}\n')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('csv', nargs='*', type=Path, help='order CSVs (default: every .csv in private/etsy-orders/)')
    ap.add_argument('--offline', action='store_true', help='use only gazetteers already in the cache')
    ap.add_argument('--cache', type=Path, default=CACHE_DIR, help='where downloaded gazetteers are kept')
    ap.add_argument('--out', type=Path, default=sales_map.DATA, help='output file (default: sales-map.json)')
    args = ap.parse_args()

    paths = args.csv or sorted(ORDERS_DIR.glob('*.csv'))
    if not paths:
        sys.exit('No order CSVs. Save Etsy\'s order exports in %s (git-ignored) or pass their paths.'
                 % ORDERS_DIR.relative_to(ROOT))
    countries = Countries(sales_map.load_basemap())
    orders, skipped = read_orders(paths)
    places, unknown, no_address, months = build_places(orders, countries)

    old = sales_map.load_data(args.out)
    previous = {place_key(p): (p['lat'], p['lon']) for p in old.get('places', [])
                if p.get('lat') is not None and p.get('lon') is not None}
    locate(places, previous, args.cache, args.offline)

    places.sort(key=lambda p: (p['country'] != 'US', p['country'], p['region'], p['city'].lower()))
    data = {
        '_readme': 'Data for the sales map on reviews.html. Made by scripts/import_etsy_orders.py from Etsy order '
                   'CSVs (kept out of the repo in private/etsy-orders/); rebuild the page with python3 '
                   'scripts/build_shop.py. Only town or city, region, country, rounded coordinates and an order '
                   'count per place: never names, addresses, ZIP codes, order IDs or money. A place with lat/lon '
                   'null is counted but not drawn; type its coordinates in by hand and later imports keep them.',
        'source': 'Etsy orders',
        'asOf': date.today().isoformat(),
        'firstOrder': min(months) if months else None,
        'lastOrder': max(months) if months else None,
        'ordersWithoutAddress': no_address,
        'places': [{'city': p['city'], 'region': p['region'], 'country': p['country'], 'lat': p['lat'],
                    'lon': p['lon'], 'orders': p['orders']} for p in places],
    }
    write_json(args.out, data)

    counted = sum(p['orders'] for p in places)
    off_map = [p for p in places if p['lat'] is None]
    print('\n%d orders counted across %d places in %d countries; %d without a shipping address '
          '(digital downloads); %d duplicate rows and %d cancelled orders skipped.'
          % (counted, len(places), len({p['country'] for p in places}), no_address, skipped['duplicate'],
             skipped['cancelled']))
    for name, n in sorted(unknown.items()):
        print('warning %d order(s) with unrecognised country %r were left out; add it to COUNTRY_ALIASES' % (n, name))
    if off_map:
        print('\nNo coordinates for these (counted, but not drawn). Add lat/lon in %s by hand if you like:'
              % args.out.name)
        for p in off_map:
            print('  %s, %s, %s (%d)' % (p['city'] or '-', p['region'] or '-', p['country'], p['orders']))
    shown = args.out.relative_to(ROOT) if args.out.is_relative_to(ROOT) else args.out
    print('\nwrote   %s. Look over its place list before committing, then run python3 scripts/build_shop.py.' % shown)


if __name__ == '__main__':
    main()

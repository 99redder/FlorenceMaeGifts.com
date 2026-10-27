#!/usr/bin/env python3
"""Count how many of each listing has sold on Etsy, for the "sold" lines on the shop pages.

  python3 scripts/import_etsy_items.py     # every .csv in private/etsy-items/
  python3 scripts/import_etsy_items.py --add new.csv   # add sales after "lastSale" to the saved counts
  python3 scripts/build_shop.py            # then rebuild the pages

Input: Etsy's "Order Items" exports (Shop Manager > Settings > Options > Download
Data, CSV type "Order Items", month blank, one file per year; Etsy emails a link).
Keep them in private/etsy-items/, which is git-ignored: they hold buyers' names
and addresses and must never be committed.

Output: item-stats.json holds only a quantity sold per Etsy listing ID for the
listings in products.json, plus the date range. No names, addresses, order IDs
or money. Transactions are counted once by Transaction ID across all files.
"""
import csv
import json
import re
import sys
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ITEMS_DIR = ROOT / 'private' / 'etsy-items'
OUT = ROOT / 'item-stats.json'


def listing_id(product):
    m = re.search(r'/listing/(\d+)', product.get('etsyUrl') or '')
    return m.group(1) if m else None


def sale_date(text):
    for fmt in ('%m/%d/%y', '%m/%d/%Y', '%Y-%m-%d'):
        try:
            return datetime.strptime((text or '').strip(), fmt).date()
        except ValueError:
            continue
    return None


def main():
    args = sys.argv[1:]
    add = '--add' in args
    paths = [Path(a) for a in args if a != '--add'] or sorted(ITEMS_DIR.glob('*.csv'))
    if not paths:
        sys.exit('No Order Items CSVs. Save them in %s (git-ignored).' % ITEMS_DIR.relative_to(ROOT))
    wanted = {listing_id(p) for p in json.loads((ROOT / 'products.json').read_text())['products']} - {None}
    seen, sold, dates = set(), {}, []
    after = None
    if add:
        old = json.loads(OUT.read_text())
        after = date.fromisoformat(old['lastSale'])
        sold = dict(old['sold'])
        print('adding  items sold after %s to the counts in %s' % (after, OUT.name))
    added = 0
    for path in paths:
        with open(path, newline='', encoding='utf-8-sig') as f:
            rows = list(csv.DictReader(f))
        if rows and 'Listing ID' not in rows[0]:
            sys.exit('%s is not an Order Items export (no "Listing ID" column)' % path.name)
        print('read    %s: %d items' % (path.name, len(rows)))
        for r in rows:
            key = r.get('Transaction ID') or (r.get('Order ID'), r.get('Listing ID'), r.get('Variations'))
            if key in seen:
                continue
            seen.add(key)
            d = sale_date(r.get('Sale Date'))
            if after and (d is None or d <= after):
                continue  # already counted
            if d:
                dates.append(d)
            lid = (r.get('Listing ID') or '').strip()
            if lid in wanted:
                try:
                    qty = int(float(r.get('Quantity') or 1))
                except ValueError:
                    qty = 1
                sold[lid] = sold.get(lid, 0) + qty
                added += qty
    data = {
        '_readme': 'Quantity sold on Etsy per listing ID (listings in products.json only), used for the "sold" '
                   'lines on the shop pages. Made by scripts/import_etsy_items.py from Etsy Order Items CSVs kept '
                   'in private/etsy-items/ (git-ignored). No names, addresses, order IDs or money. lastSale is the '
                   'last sale date counted: to update, download only newer Order Items CSVs and run the importer '
                   'with --add.',
        'asOf': date.today().isoformat(),
        'firstSale': old['firstSale'] if add else (min(dates).isoformat() if dates else None),
        'lastSale': max(dates).isoformat() if dates else (old['lastSale'] if add else None),
        'sold': dict(sorted(sold.items(), key=lambda kv: (-kv[1], kv[0]))),
    }
    OUT.write_text(json.dumps(data, indent=1) + '\n')
    if add:
        print('added   %d items' % added)
    print('\n%d items across %d site listings, %s to %s' % (sum(sold.values()), len(sold),
                                                            data['firstSale'], data['lastSale']))
    print('wrote   %s; run python3 scripts/build_shop.py' % OUT.name)


if __name__ == '__main__':
    main()

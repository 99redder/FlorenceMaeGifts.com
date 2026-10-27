#!/usr/bin/env python3
"""Rebuild scripts/geo/basemap.json, the outlines behind the sales map on reviews.html.

  python3 scripts/geo/make_basemap.py

Downloads Natural Earth's 1:50m countries and US states (public domain,
https://www.naturalearthdata.com, via github.com/nvkelso/natural-earth-vector),
projects them with the functions in scripts/sales_map.py, simplifies them to
about half a pixel and writes them as SVG path data. Only needed if the
projection or the outlines change; scripts/build_shop.py just reads the JSON.
"""
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import sales_map  # noqa: E402

SOURCE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/'
COUNTRIES = 'ne_50m_admin_0_countries.geojson'
STATES = 'ne_50m_admin_1_states_provinces_lakes.geojson'
TOLERANCE = 0.45      # px in the 960-wide frame
MIN_RING = 1.2        # drop islands smaller than this many px across (each shape keeps its largest ring)
DISPLAY_NAMES = {'US': 'United States'}
ALIAS_FIELDS = ('NAME', 'NAME_LONG', 'ADMIN', 'NAME_EN', 'FORMAL_EN', 'NAME_ALT', 'NAME_SORT', 'BRK_NAME',
                'GEOUNIT', 'SUBUNIT', 'NAME_CIAWF', 'ISO_A3_EH')


def fetch(name):
    print('downloading', name)
    with urllib.request.urlopen(SOURCE + name) as r:
        return json.load(r)


def polygons(geometry):
    if geometry['type'] == 'Polygon':
        return [geometry['coordinates']]
    if geometry['type'] == 'MultiPolygon':
        return geometry['coordinates']
    return []


def simplify(points, tol):
    """Douglas-Peucker on a closed ring of projected points."""
    if len(points) < 5:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = points[a], points[b]
        dx, dy = bx - ax, by - ay
        seg = dx * dx + dy * dy
        best, idx = 0.0, None
        for i in range(a + 1, b):
            px, py = points[i]
            if seg:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / seg))
                ex, ey = ax + t * dx - px, ay + t * dy - py
            else:
                ex, ey = ax - px, ay - py
            d = ex * ex + ey * ey
            if d > best:
                best, idx = d, i
        if idx is not None and best > tol * tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(points, keep) if k]


def tenths(v):
    return int(round(v * 10))


def fmt(t):
    a = abs(t)
    s = '%d' % (a // 10) if a % 10 == 0 else ('%d.%d' % (a // 10, a % 10)).lstrip('0')
    return ('-' if t < 0 else '') + s


def ring_path(points):
    pts = []
    for x, y in points:
        p = (tenths(x), tenths(y))
        if not pts or pts[-1] != p:
            pts.append(p)
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    if len(pts) < 3:
        return ''
    out = 'M' + fmt(pts[0][0]) + ',' + fmt(pts[0][1]) + 'l'
    nums = []
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        nums += [fmt(x1 - x0), fmt(y1 - y0)]
    for i, n in enumerate(nums):
        out += n if i == 0 or n.startswith('-') else ' ' + n
    return out + 'z'


def shape_path(rings, bounds):
    """rings: projected outer/inner rings of one shape. Returns path data; updates bounds [minx, miny, maxx, maxy]."""
    sized = []
    for ring in rings:
        xs, ys = [p[0] for p in ring], [p[1] for p in ring]
        sized.append((max(max(xs) - min(xs), max(ys) - min(ys)), ring))
    biggest = max(s for s, _ in sized)
    parts = []
    for size, ring in sized:
        if size < MIN_RING and size != biggest:
            continue
        d = ring_path(simplify(ring, TOLERANCE))
        if d:
            parts.append(d)
            for x, y in ring:
                bounds[0], bounds[1] = min(bounds[0], x), min(bounds[1], y)
                bounds[2], bounds[3] = max(bounds[2], x), max(bounds[3], y)
    return ''.join(parts)


def view_box(bounds, pad):
    x0, y0 = int(bounds[0] - pad), int(bounds[1] - pad)
    return '%d %d %d %d' % (x0, y0, int(bounds[2] + pad + 1) - x0, int(bounds[3] + pad + 1) - y0)


def world(data):
    shapes = {}
    for f in data['features']:
        p = f['properties']
        if p['ADM0_A3'] == 'ATA':
            continue
        code = p['ISO_A2_EH'] if p['ISO_A2_EH'] not in ('-99', None) else p['ADM0_A3']
        main = p['ADM0_A3'] == p['SOV_A3'] or code not in shapes
        entry = shapes.setdefault(code, {'id': code, 'rings': []})
        if main:
            name = DISPLAY_NAMES.get(code, p['NAME_EN'] or p['NAME'])
            aliases = sorted({str(p[k]) for k in ALIAS_FIELDS if p.get(k)} - {name}, key=str.lower)
            entry.update(name=name, continent=p['CONTINENT'], aliases=aliases)
        for poly in polygons(f['geometry']):
            entry['rings'] += [[sales_map.world_xy(lon, lat) for lon, lat in ring] for ring in poly]
    bounds = [1e9, 1e9, -1e9, -1e9]
    countries = []
    for code in sorted(shapes):
        s = shapes[code]
        countries.append({'id': code, 'name': s['name'], 'continent': s['continent'], 'aliases': s['aliases'],
                          'd': shape_path(s['rings'], bounds)})
    return {'viewBox': view_box(bounds, 4), 'countries': countries}


def us(data):
    bounds = [1e9, 1e9, -1e9, -1e9]
    states = []
    for f in sorted((f for f in data['features'] if f['properties']['adm0_a3'] == 'USA'),
                    key=lambda f: f['properties']['postal']):
        code = f['properties']['postal']
        rings = []
        for poly in polygons(f['geometry']):
            for ring in poly:
                # The far western Aleutians sit past 180 degrees; Albers USA leaves them out too.
                if code == 'AK' and all(lon > 0 for lon, _ in ring):
                    continue
                rings.append([sales_map.us_xy(lon, lat, code) for lon, lat in ring])
        states.append({'id': code, 'name': sales_map.US_STATES[code], 'd': shape_path(rings, bounds)})
    return {'viewBox': view_box(bounds, 6), 'states': states}


def main():
    out = {
        '_readme': 'Outlines for the sales map on reviews.html, already projected to SVG path data (world: Natural '
                   'Earth projection, 960 wide; us: Albers USA). Made by scripts/geo/make_basemap.py from Natural '
                   'Earth 1:50m (public domain). Do not hand-edit. Country ids are ISO 3166-1 alpha-2 codes; '
                   'aliases help scripts/import_etsy_orders.py match the country names in Etsy CSVs.',
        'world': world(fetch(COUNTRIES)),
        'us': us(fetch(STATES)),
    }
    # One shape per line keeps diffs readable.
    lines = ['{', '"_readme": %s,' % json.dumps(out['_readme'])]
    for key, shapes in (('world', 'countries'), ('us', 'states')):
        lines.append('"%s": {"viewBox": "%s", "%s": [' % (key, out[key]['viewBox'], shapes))
        rows = [json.dumps(s, ensure_ascii=False, separators=(',', ':')) for s in out[key][shapes]]
        lines.append(',\n'.join(rows))
        lines.append(']}' + (',' if key == 'world' else ''))
    lines.append('}')
    path = Path(__file__).resolve().parent / 'basemap.json'
    path.write_text('\n'.join(lines) + '\n')
    json.loads(path.read_text())
    print('wrote', path.relative_to(sales_map.ROOT), '(%d KB)' % (path.stat().st_size // 1024))


if __name__ == '__main__':
    main()

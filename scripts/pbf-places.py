"""Filter an OpenStreetMap .pbf (Geofabrik extract) for places with a website that fit --match selectors (same syntax as fetch-osm-places.ts). Needs: pip install osmium.

python3 -I scripts/pbf-places.py <in.pbf> <out.csv> --match='cuisine~pizza' --match='name~pizz&&amenity~restaurant|fast_food|cafe|bar|pub'
"""
import csv, re, sys
import osmium

args = sys.argv[1:]
matches = [a[len('--match='):] for a in args if a.startswith('--match=')]
src, out = [a for a in args if not a.startswith('--')]

def cond(c):
    m = re.match(r'^([A-Za-z0-9_:.-]+)(~|=)(.+)$', c.strip())
    if not m:
        raise SystemExit(f'bad condition {c!r}')
    key, op, val = m.groups()
    if op == '~':
        rx = re.compile(val, re.I)
        return lambda t: key in t and rx.search(t[key]) is not None
    return lambda t: t.get(key) == val

selectors = [[cond(c) for c in m.split('&&')] for m in matches]
rows = {}
counts = {'tagged': 0, 'with_website': 0}

fp = osmium.FileProcessor(src).with_filter(osmium.filter.KeyFilter('website', 'contact:website', 'url'))
for o in fp:
    t = {x.k: x.v for x in o.tags}
    if not any(all(c(t) for c in sel) for sel in selectors):
        continue
    counts['tagged'] += 1
    w = (t.get('website') or t.get('contact:website') or t.get('url') or '').split(';')[0].strip()
    if not w:
        continue
    counts['with_website'] += 1
    rows.setdefault(((t.get('name') or '') + '|' + w).lower(), (t.get('name') or '', w))
with open(out, 'w', newline='') as f:
    wr = csv.writer(f)
    wr.writerow(['name', 'website'])
    wr.writerows(rows.values())
print(f"{src}: {counts['tagged']} matching places, {counts['with_website']} with a website, {len(rows)} unique -> {out}")

"""Move chain rows of a just-written new list into the next numbered chains list (a domain already in a chains list, or 3+ rows; hosting platforms excluded).

python3 -I scripts/split-chains.py <category dir> <shops file> <chains list base, e.g. pizza-chains> <cc>
"""
import csv, re, glob, collections, os, sys
d, shops, base, cc = sys.argv[1:5]
PLATFORMS = ('square.site', 'wixsite.com', 'weebly.com', 'godaddysites.com', 'myshopify.com', 'squarespace.com', 'wordpress.com', 'business.site', 'poi.place', 'placeweb.site', 'websyte.com.au', 'lifeintouch.net', 'blogspot.com', 'wix.com', 'edu.au')
def dom(u):
    h = re.sub(r'^https?://(www\.)?', '', u).split('/')[0].lower(); p = h.split('.')
    return '.'.join(p[-3:] if len(p) > 2 and p[-2] in ('com', 'co', 'org', 'net') else p[-2:])
chain_doms = {dom(r['website']) for f in glob.glob(f'{d}/{base}*.{cc}.csv') for r in csv.DictReader(open(f))}
rows = list(csv.DictReader(open(shops)))
cnt = collections.Counter(dom(r['website']) for r in rows)
chain = [r for r in rows if dom(r['website']) not in PLATFORMS and (dom(r['website']) in chain_doms or cnt[dom(r['website'])] >= 3)]
keep = [r for r in rows if r not in chain]
n = max([int(m.group(1) or 1) for f in os.listdir(d) if (m := re.fullmatch(rf'{re.escape(base)}(?:-(\d+))?\.{cc}\.csv', f))] + [1]) + 1
out = f'{d}/{base}-{n}.{cc}.csv'
for p, data in ((shops, keep), (out, chain)):
    if data or p == shops:
        with open(p, 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=['name', 'website']); w.writeheader(); w.writerows(data)
print(f'{shops}: {len(keep)} shops; {out if chain else "no chains"}: {len(chain)} chain rows', sorted({dom(r["website"]) for r in chain})[:12])

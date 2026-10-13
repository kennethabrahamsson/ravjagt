"""Bygger data/dk.json: Danmarks kyst delt i strækninger med åbent hav (fetch) i 16 retninger.

Input (hentes til tools/cache/, se README):
  dk_coast.json   OSM natural=coastline i Danmark (Overpass, out geom)
  dk_traps.json   OSM man_made=groyne|breakwater i Danmark
  dk_places.json  OSM stednavne og strande
  ne/ne_10m_coastline.geojson  Natural Earth – nabolandenes kyster, så Sverige m.fl. blokerer

Kør:  python3 -I tools/build_coast.py
"""
import json, math, os, sys, time
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, 'cache')
OUT = os.path.join(HERE, '..', 'data', 'dk.json')

SEG_M = 1500          # strækningslængde
MIN_LINE_M = 1200     # mindre øer/holme springes over
OPEN_KM = 50          # så meget åbent vand skal der være foran, før kysten tæller som ravkyst
MAX_FETCH_KM = 250
DIRS = 16

t0 = time.time()
def log(*a): print(f'[{time.time()-t0:5.1f}s]', *a, file=sys.stderr)

# ---------- geometri ----------
LAT0 = 56.0
KX = 111320 * math.cos(math.radians(LAT0))
KY = 110574
def xy(lat, lon): return (lon * KX, lat * KY)
def dist(a, b): return math.hypot((a[1]-b[1]) * 111320 * math.cos(math.radians((a[0]+b[0])/2)), (a[0]-b[0]) * KY)
def bearing(a, b):
    y = math.sin(math.radians(b[1]-a[1])) * math.cos(math.radians(b[0]))
    x = math.cos(math.radians(a[0]))*math.sin(math.radians(b[0])) - math.sin(math.radians(a[0]))*math.cos(math.radians(b[0]))*math.cos(math.radians(b[1]-a[1]))
    return (math.degrees(math.atan2(y, x)) + 360) % 360
def move(p, brg, m):
    lat = p[0] + m * math.cos(math.radians(brg)) / KY
    lon = p[1] + m * math.sin(math.radians(brg)) / (111320 * math.cos(math.radians(p[0])))
    return (lat, lon)

def simplify(pts, tol):
    if len(pts) < 3: return pts
    P = [xy(*p) for p in pts]
    keep = [False]*len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts)-1)]
    while stack:
        i, j = stack.pop()
        ax, ay = P[i]; bx, by = P[j]; dx, dy = bx-ax, by-ay; L = math.hypot(dx, dy) or 1e-9
        best, bi = -1, -1
        ring = math.hypot(dx, dy) < 1  # lukket ring (ø): mål afstanden til punktet
        for k in range(i+1, j):
            px, py = P[k]
            d = math.hypot(px-ax, py-ay) if ring else abs(dy*px - dx*py + bx*ay - by*ax) / L
            if d > best: best, bi = d, k
        if best > tol:
            keep[bi] = True; stack.append((i, bi)); stack.append((bi, j))
    return [p for p, k in zip(pts, keep) if k]

# ---------- 1. kædning af kystlinjer ----------
ways = json.load(open(os.path.join(CACHE, 'dk_coast.json')))['elements']
log('ways', len(ways))
by_start = {}
for w in ways: by_start.setdefault(w['nodes'][0], []).append(w)
used = set(); lines = []
for w in ways:
    if w['id'] in used: continue
    used.add(w['id'])
    nodes = list(w['nodes']); geom = [(g['lat'], g['lon']) for g in w['geometry']]
    while True:  # fremad
        nxt = [x for x in by_start.get(nodes[-1], []) if x['id'] not in used]
        if not nxt: break
        x = nxt[0]; used.add(x['id'])
        nodes += x['nodes'][1:]; geom += [(g['lat'], g['lon']) for g in x['geometry'][1:]]
    lines.append(geom)
log('kædede linjer', len(lines))

# ---------- 2. strækninger ----------
segs = []
def region(line):
    # Vest = Jylland (fastlandet er den eneste åbne linje – den fortsætter ind i Tyskland)
    # samt øer vest for 10° eller nord for 56,6° (Fanø, Rømø, Mandø, Læsø, Anholt).
    # Øst = Sjælland, Fyn, Lolland-Falster, Møn, Bornholm og de andre øer.
    if dist(line[0], line[-1]) > 5: return 'v'
    lat = sum(p[0] for p in line) / len(line); lon = sum(p[1] for p in line) / len(line)
    return 'v' if lon < 10.0 or lat > 56.6 else 'o'

for line in lines:
    reg = region(line)
    line = simplify(line, 25)
    cum = [0.0]
    for a, b in zip(line, line[1:]): cum.append(cum[-1] + dist(a, b))
    total = cum[-1]
    if total < MIN_LINE_M: continue
    n = max(1, round(total / SEG_M))
    step = total / n
    def at(d):
        d = max(0.0, min(total, d))
        lo, hi = 0, len(cum)-1
        while lo < hi - 1:
            mid = (lo+hi)//2
            if cum[mid] <= d: lo = mid
            else: hi = mid
        f = 0 if cum[hi] == cum[lo] else (d-cum[lo])/(cum[hi]-cum[lo])
        a, b = line[lo], line[hi]
        return (a[0] + (b[0]-a[0])*f, a[1] + (b[1]-a[1])*f)
    closed = dist(line[0], line[-1]) < 5
    for k in range(n):
        d0, d1 = k*step, (k+1)*step
        pts = [at(d0)] + [p for p, c in zip(line, cum) if d0 < c < d1] + [at(d1)]
        mid = at((d0+d1)/2)
        # Kystens retning udglattes over ±1,7 km; havet ligger til højre for OSM-kystlinjen
        def wrap(d): return d % total if closed else d
        a, b = at(wrap((d0+d1)/2 - 1700)), at(wrap((d0+d1)/2 + 1700))
        if dist(a, b) < 300: a, b = pts[0], pts[-1]
        normal = (bearing(a, b) + 90) % 360
        segs.append({'mid': mid, 'pts': simplify(pts, 15), 'normal': normal, 'r': reg})
log('strækninger', len(segs))

# ---------- 3. raster til fetch ----------
B = dict(lat0=53.3, lat1=59.8, lon0=3.5, lon1=17.0)
DLAT, DLON = 0.0025, 0.004
NY = int((B['lat1']-B['lat0'])/DLAT) + 1
NX = int((B['lon1']-B['lon0'])/DLON) + 1
grid = bytearray(NX*NY)   # 1 = dansk kyst (OSM, præcis), 2 = nabolandes kyst (Natural Earth, grov)
def cell(lat, lon):
    i = int((lat-B['lat0'])/DLAT); j = int((lon-B['lon0'])/DLON)
    if 0 <= i < NY and 0 <= j < NX: return i*NX + j
    return -1
def burn(pts, val=1):
    for a, b in zip(pts, pts[1:]):
        n = int(max(abs(b[0]-a[0])/DLAT, abs(b[1]-a[1])/DLON) * 2) + 1
        for s in range(n+1):
            f = s/n
            c = cell(a[0]+(b[0]-a[0])*f, a[1]+(b[1]-a[1])*f)
            if c >= 0 and not grid[c]: grid[c] = val
for line in lines: burn(line)
ne = json.load(open(os.path.join(CACHE, 'ne', 'ne_10m_coastline.geojson')))
for f in ne['features']:
    g = f['geometry']
    parts = g['coordinates'] if g['type'] == 'MultiLineString' else [g['coordinates']]
    for part in parts:
        pts = [(c[1], c[0]) for c in part]
        if any(B['lat0'] <= p[0] <= B['lat1'] and B['lon0'] <= p[1] <= B['lon1'] for p in pts): burn(pts, 2)
log('raster', NX, 'x', NY)

def fetch_km(p, brg):
    start = move(p, brg, 600)
    step = 250
    lat, lon = start
    dlat = step * math.cos(math.radians(brg)) / KY
    for k in range(1, int(MAX_FETCH_KM*1000/step)):
        lat += dlat
        lon += step * math.sin(math.radians(brg)) / (111320 * math.cos(math.radians(lat)))
        c = cell(lat, lon)
        if c < 0: return MAX_FETCH_KM
        # Dansk kyst er præcis og tæller fra 300 m; den grove nabokyst først fra 1,5 km,
        # så Natural Earths egen (unøjagtige) danske kyst ikke stopper strålen ved start
        g = grid[c]
        if (g == 1 and k*step > 300) or (g == 2 and k*step > 1500):
            return round((600 + k*step) / 1000)
    return MAX_FETCH_KM

for n, s in enumerate(segs):
    f = []
    for d in range(DIRS):
        brg = d * 360 / DIRS
        off = abs(((brg - s['normal'] + 540) % 360) - 180)
        f.append(fetch_km(s['mid'], brg) if off <= 85 else 0)
    s['fetch'] = f
    # Åben kyst: mindst to retninger inden for ±60° af stranden med langt åbent vand.
    # En fjord har højst én lang retning; en kyst i læ af et næs (fx Hornbæk bag Kullen) har stadig flere.
    fan = [f[d] for d in range(DIRS) if abs(((d*360/DIRS - s['normal'] + 540) % 360) - 180) <= 60]
    s['open'] = OPEN_KM if sum(1 for x in fan if x >= OPEN_KM) >= 2 else 0
    if n % 500 == 0: log('fetch', n)
log('fetch færdig')

# ---------- 4. fælder ----------
hashp = defaultdict(list)
def hk(lat, lon): return (int(lat/0.003), int(lon/0.005))
for i, s in enumerate(segs):
    for p in s['pts']: hashp[hk(*p)].append(i)
traps = json.load(open(os.path.join(CACHE, 'dk_traps.json')))['elements']
trap_lines = []
for t in traps:
    g = [(x['lat'], x['lon']) for x in t['geometry']]
    near = set()
    for p in g:
        a, b = hk(*p)
        for da in (-1, 0, 1):
            for db in (-1, 0, 1):
                for i in hashp.get((a+da, b+db), []):
                    if any(dist(p, q) < 200 for q in segs[i]['pts']): near.add(i)
    if not near: continue
    best = min(near, key=lambda i: dist(g[0], segs[i]['mid']))
    if segs[best]['open'] < OPEN_KM: continue
    segs[best]['traps'] = segs[best].get('traps', 0) + 1
    trap_lines.append([[round(p[0], 5), round(p[1], 5)] for p in simplify(g, 5)])
log('fælder ved åben kyst', len(trap_lines))

# ---------- 5. navne ----------
places = json.load(open(os.path.join(CACHE, 'dk_places.json')))['elements']
RANK = {'beach': 0, 'town': 1, 'city': 1, 'village': 2, 'suburb': 3, 'cape': 3, 'peninsula': 4, 'hamlet': 4, 'locality': 5, 'isolated_dwelling': 6}
P = []
for e in places:
    lat = e.get('lat') or e.get('center', {}).get('lat'); lon = e.get('lon') or e.get('center', {}).get('lon')
    kind = e['tags'].get('place') or e['tags'].get('natural')
    if lat and e['tags'].get('name'): P.append((lat, lon, e['tags']['name'], RANK.get(kind, 6)))
ph = defaultdict(list)
for p in P: ph[(int(p[0]/0.05), int(p[1]/0.08))].append(p)
for s in segs:
    lat, lon = s['mid']; cands = []
    for da in (-1, 0, 1):
        for db in (-1, 0, 1):
            for p in ph.get((int(lat/0.05)+da, int(lon/0.08)+db), []):
                d = dist(s['mid'], (p[0], p[1]))
                if d < 5000: cands.append((d/1000 + p[3]*0.9, p, d))
    if cands:
        _, p, d = min(cands)
        s['name'] = p[2]; s['anchor'] = (p[0], p[1])
    else:
        s['name'] = 'Kyst'; s['anchor'] = s['mid']
groups = defaultdict(list)
for s in segs: groups[s['name']].append(s)
for name, g in groups.items():
    if len(g) < 2: continue
    for s in g:
        d = dist(s['mid'], s['anchor'])
        if d >= 600:
            brg = bearing(s['anchor'], s['mid'])
            word = ['nord', 'nordøst', 'øst', 'sydøst', 'syd', 'sydvest', 'vest', 'nordvest'][round(brg/45) % 8]
            s['name'] = f"{name}, {str(round(d/500)/2).replace('.', ',').replace(',0', '')} km {word}"

# ---------- 6. vejrpunkter ----------
cells = defaultdict(list)
for i, s in enumerate(segs):
    if s['open'] >= OPEN_KM: cells[(int((s['mid'][0]-53)/0.35), int((s['mid'][1]-3)/0.55))].append(i)
points = []
for key, idx in sorted(cells.items()):
    lat = sum(segs[i]['mid'][0] for i in idx)/len(idx); lon = sum(segs[i]['mid'][1] for i in idx)/len(idx)
    # Havmodellen: et punkt 6 km ud for kysten i strækningernes gennemsnitlige retning
    sx = sum(math.sin(math.radians(segs[i]['normal'])) for i in idx); cx = sum(math.cos(math.radians(segs[i]['normal'])) for i in idx)
    sea = move((lat, lon), (math.degrees(math.atan2(sx, cx))+360) % 360, 6000)
    for i in idx: segs[i]['p'] = len(points)
    points.append([round(lat, 3), round(lon, 3), round(sea[0], 3), round(sea[1], 3)])
for s in segs:
    if 'p' not in s:
        s['p'] = min(range(len(points)), key=lambda k: dist(s['mid'], (points[k][0], points[k][1])))
log('vejrpunkter', len(points))

# ---------- 7. ud ----------
out = {
    'v': 1, 'built': time.strftime('%Y-%m-%d'), 'openKm': OPEN_KM,
    'points': points,
    'segs': [{
        'n': s['name'], 'c': [round(s['mid'][0], 5), round(s['mid'][1], 5)], 'nm': round(s['normal']),
        'f': s['fetch'], 'o': 1 if s['open'] >= OPEN_KM else 0, 't': s.get('traps', 0), 'p': s['p'],
        'r': s['r'],
        'l': [[round(p[0], 5), round(p[1], 5)] for p in s['pts']],
    } for s in segs],
    'traps': trap_lines,
}
json.dump(out, open(OUT, 'w'), separators=(',', ':'), ensure_ascii=False)
log('skrevet', OUT, os.path.getsize(OUT)//1024, 'KB ·', sum(1 for s in segs if s['open'] >= OPEN_KM), 'af', len(segs), 'strækninger er åben kyst')

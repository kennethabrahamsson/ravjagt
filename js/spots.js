// Danmarks kyst i strækninger på ca. 1,5 km, bygget af tools/build_coast.py til data/dk.json.
// Hver strækning har retning mod havet, åbent vand (fetch) i 16 retninger, antal høfder/moler
// og hvilket vejrpunkt den hører til. Kun "åben kyst" (nok åbent hav foran) farves.

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

export function distance(a, b) {
  const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function bearing(a, b) {
  const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
  const x = Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) - Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export async function loadCoast() {
  const d = await fetch('data/dk.json').then((r) => r.json());
  const spots = d.segs.map((s, i) => ({
    id: `s${i}`, name: s.n, center: s.c, normal: s.nm, fetch: s.f, open: !!s.o,
    traps: s.t, point: s.p, line: s.l, region: s.r,
  }));
  return { spots, points: d.points, trapLines: d.traps, openKm: d.openKm };
}

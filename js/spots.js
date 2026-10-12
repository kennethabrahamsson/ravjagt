// Kyststrækninger og fælder (moler og bølgebrydere) fra OpenStreetMap-data i data/coast.json.

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

// Stednavne langs kysten (breddegrad), slået op i OpenStreetMap
const ANCHORS = [
  ['Haurvig', 55.945], ['Renderne', 55.961], ['Hundested', 55.98], ['Hvide Sande', 55.999],
  ['Sønder Lyngvig', 56.025], ['Lyngvig Fyr', 56.0496], ['Stormodden', 56.075], ['Tyvmose', 56.09],
  ['Søndervig', 56.108], ['Søndervig Nord', 56.128], ['Hovvig', 56.15], ['Sidselbjerg Strand', 56.17],
  ['Nord for Sidselbjerg', 56.19],
];
const nameFor = (lat) => ANCHORS.reduce((best, a) => (Math.abs(a[1] - lat) < Math.abs(best[1] - lat) ? a : best))[0];

const TRAP_GROUPS = [
  { key: 'hs-nord', name: 'Hvide Sande · nordmolen', side: 'north', ids: [156670125, 921148802, 921148803], hint: 'Gå langs nordsiden af molen og i hjørnet ved stranden.' },
  { key: 'hs-syd', name: 'Hvide Sande · sydmolen', side: 'south', ids: [208286778], hint: 'Gå langs sydsiden af molen.' },
  { key: 'sidselbjerg', name: 'Bølgebryderne nord for Sidselbjerg', side: 'both', ids: [651524614, 651524616, 651524618, 651524621, 651524623, 651524625, 651524627, 651524630, 651524632, 651524634, 651524637, 651524639, 651524641], hint: 'Led i lommerne mellem bølgebryderne.' },
  { key: 'hundested', name: 'Bølgebryderne ved Hundested', side: 'both', ids: [651525667, 651525668, 651525669], hint: 'Led i lommerne mellem bølgebryderne.' },
  { key: 'renderne', name: 'Bølgebryderne ved Renderne', side: 'both', ids: [651525665, 651525666], hint: 'Led i lommerne mellem bølgebryderne.' },
];

export async function loadSpots() {
  const data = await fetch('data/coast.json').then((r) => r.json());
  const coast = data.coast; // [[lat, lon]] fra syd mod nord

  // Strækninger på ca. 1 km
  const zones = [];
  let cur = [coast[0]], len = 0;
  for (let k = 1; k < coast.length; k++) {
    const d = distance(coast[k - 1], coast[k]);
    cur.push(coast[k]);
    len += d;
    if (len >= 1000 || k === coast.length - 1) {
      zones.push(cur);
      cur = [coast[k]];
      len = 0;
    }
  }

  // Kystens retning udglattes over ca. 3,5 km, så havneindløb og knæk ikke giver en skæv retning
  const nearestTo = (lat) => coast.reduce((best, p) => (Math.abs(p[0] - lat) < Math.abs(best[0] - lat) ? p : best));
  const normalAt = (lat) => {
    const along = bearing(nearestTo(lat - 0.016), nearestTo(lat + 0.016)); // kysten løber mod nord
    return (along - 90 + 360) % 360; // havet ligger til venstre
  };

  const spots = zones.map((line, n) => {
    const mid = line[Math.floor(line.length / 2)];
    const normal = normalAt(mid[0]);
    return { id: `z${n}`, kind: 'zone', name: nameFor(mid[0]), line, center: mid, normal };
  });

  // Flere strækninger ved samme stednavn: den nærmeste får navnet, de andre får afstand og retning
  const byName = new Map();
  spots.forEach((s) => { if (!byName.has(s.name)) byName.set(s.name, []); byName.get(s.name).push(s); });
  for (const [name, group] of byName) {
    if (group.length < 2) continue;
    const anchorLat = ANCHORS.find((a) => a[0] === name)[1];
    for (const s of group) {
      const km = Math.abs(s.center[0] - anchorLat) * 111.2;
      if (km >= 0.5) s.name = `${name}, ${String(Math.round(km * 2) / 2).replace('.', ',')} km ${s.center[0] > anchorLat ? 'nord' : 'syd'}`;
    }
  }

  // Fælder
  const byId = new Map(data.traps.map((t) => [t.id, t]));
  for (const g of TRAP_GROUPS) {
    const members = g.ids.map((id) => byId.get(id)).filter(Boolean);
    if (!members.length) continue;
    const lat = members.reduce((s, m) => s + m.lat, 0) / members.length;
    const lon = members.reduce((s, m) => s + m.lon, 0) / members.length;
    spots.push({
      id: g.key, kind: 'trap', name: g.name, hint: g.hint, center: [lat, lon], normal: normalAt(lat),
      trap: { side: g.side }, lines: members.map((m) => m.line),
    });
  }
  return spots;
}

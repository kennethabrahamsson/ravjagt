// Vejr og hav fra Open-Meteo (gratis, ingen nøgle) for vejrpunkterne langs kysten (data/dk.json).
// Vind fra DMI's HARMONIE-model (2 km over Danmark, dmi_seamless). Punkterne hentes i tre kald,
// der kører samtidig: ét kald med alle 66 punkter tog 30+ sekunder, tre kald tager ca. 1,5.
// Seneste vejr gemmes på telefonen, så appen altid kan vise noget med det samme og virker uden net.

const CACHE_KEY = 'ravjagt.weather.v3';
const TIMEOUT_MS = 20000;
const CHUNKS = 3;

export function cachedWeather(points) {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY));
    return c && c.n === points.length ? c : null;
  } catch { return null; }
}

let inflight = null;
// Henter nyt vejr. Kun ét kald ad gangen; afvises efter TIMEOUT_MS.
export function fetchWeather(points) {
  if (!inflight) {
    inflight = doFetch(points)
      .then((w) => { try { localStorage.setItem(CACHE_KEY, JSON.stringify(w)); } catch {} return w; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const COMMON = 'timezone=Europe%2FCopenhagen&past_days=3&forecast_days=6';

async function doFetch(points) {
  const chunks = Array.from({ length: CHUNKS }, (_, k) => points.map((p, i) => [p, i]).filter(([, i]) => i % CHUNKS === k));
  const wxParts = chunks.map((c) => {
    const lat = c.map(([p]) => p[0]).join(','), lon = c.map(([p]) => p[1]).join(',');
    return getJson(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day&wind_speed_unit=ms&models=dmi_seamless&${COMMON}`)
      .then((j) => (Array.isArray(j) ? j : [j]).map((w, k) => [c[k][1], w]));
  });
  const slat = points.map((p) => p[2]).join(','), slon = points.map((p) => p[3]).join(',');
  const seaReq = getJson(`https://marine-api.open-meteo.com/v1/marine?latitude=${slat}&longitude=${slon}&hourly=wave_height,sea_level_height_msl&${COMMON}`).catch(() => null);

  const [parts, sea] = await Promise.all([Promise.all(wxParts), seaReq]);
  const wx = new Array(points.length);
  for (const part of parts) for (const [i, w] of part) wx[i] = w;
  const seas = sea ? (Array.isArray(sea) ? sea : [sea]) : [];

  const series = wx.map((w, n) => {
    const h = w.hourly;
    const s = seas[n]?.hourly;
    const idx = s ? new Map(s.time.map((t, i) => [t, i])) : new Map();
    const pick = (arr, t, f) => { const i = idx.get(t); return i == null || !arr ? null : f(arr[i]); };
    return {
      time: h.time,
      ws: h.wind_speed_10m.map((v) => r1(v ?? 0)),
      wd: h.wind_direction_10m.map((v) => Math.round(v ?? 0)),
      gust: h.wind_gusts_10m.map(r1),
      temp: h.time.map(() => null),
      isDay: h.is_day,
      wave: h.time.map((t) => pick(s?.wave_height, t, r2)),
      sl: h.time.map((t) => pick(s?.sea_level_height_msl, t, r2)),
    };
  });
  return { fetchedAt: Date.now(), n: points.length, model: 'dmi_seamless', series };
}

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (r.status === 429) throw new Error('Vejrtjenesten har for travlt lige nu');
    if (!r.ok) throw new Error(`Vejrtjenesten svarede med fejl ${r.status}`);
    return await r.json();
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Vejrtjenesten svarede ikke inden for 20 sekunder' : e.message || 'Ingen forbindelse');
  } finally {
    clearTimeout(timer);
  }
}

export function hourKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`;
}

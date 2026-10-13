// Vejr og hav fra Open-Meteo (gratis, ingen nøgle) for vejrpunkterne langs kysten (data/dk.json).
// Gemmes lokalt, så appen virker uden net på stranden.

const CACHE_KEY = 'ravjagt.weather.v2';

export async function loadWeather(points, { force = false } = {}) {
  const cached = readCache();
  const same = cached && cached.n === points.length;
  if (!force && same && Date.now() - cached.fetchedAt < 30 * 60 * 1000) return cached;
  try {
    const fresh = await fetchWeather(points);
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(fresh)); } catch {}
    return fresh;
  } catch (err) {
    if (same) return { ...cached, stale: true };
    throw err;
  }
}

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch { return null; }
}

const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

async function fetchWeather(points) {
  const common = 'timezone=Europe%2FCopenhagen&past_days=3&forecast_days=6';
  const lat = points.map((p) => p[0]).join(','), lon = points.map((p) => p[1]).join(',');
  const slat = points.map((p) => p[2]).join(','), slon = points.map((p) => p[3]).join(',');
  const wxUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day,temperature_2m&wind_speed_unit=ms&${common}`;
  const seaUrl = `https://marine-api.open-meteo.com/v1/marine?latitude=${slat}&longitude=${slon}&hourly=wave_height,sea_level_height_msl&${common}`;
  const [wx, sea] = await Promise.all([getJson(wxUrl), getJson(seaUrl).catch(() => null)]);
  const wxs = Array.isArray(wx) ? wx : [wx];
  const seas = sea ? (Array.isArray(sea) ? sea : [sea]) : [];

  const series = wxs.map((w, n) => {
    const h = w.hourly;
    const s = seas[n]?.hourly;
    const idx = s ? new Map(s.time.map((t, i) => [t, i])) : new Map();
    const pick = (arr, t, f) => { const i = idx.get(t); return i == null || !arr ? null : f(arr[i]); };
    return {
      time: h.time,
      ws: h.wind_speed_10m.map((v) => r1(v ?? 0)),
      wd: h.wind_direction_10m.map((v) => Math.round(v ?? 0)),
      gust: h.wind_gusts_10m.map(r1),
      temp: h.temperature_2m.map(r1),
      isDay: h.is_day,
      wave: h.time.map((t) => pick(s?.wave_height, t, r2)),
      sl: h.time.map((t) => pick(s?.sea_level_height_msl, t, r2)),
    };
  });
  return { fetchedAt: Date.now(), n: points.length, series };
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Open-Meteo svarede ${r.status}`);
  return r.json();
}

export function hourKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`;
}

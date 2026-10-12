// Vejr og hav fra Open-Meteo (gratis, ingen nøgle). To målepunkter: Hvide Sande og Søndervig/Hovvig.
// Gemmes lokalt, så appen virker uden net på stranden.

export const POINTS = [
  { key: 'syd', wx: [56.0, 8.1], sea: [56.0, 8.06] },
  { key: 'nord', wx: [56.15, 8.11], sea: [56.15, 8.08] },
];
export const pointFor = (lat) => (lat < 56.07 ? 0 : 1);

const CACHE_KEY = 'ravjagt.weather.v1';

export async function loadWeather({ force = false } = {}) {
  const cached = readCache();
  if (!force && cached && Date.now() - cached.fetchedAt < 30 * 60 * 1000) return cached;
  try {
    const fresh = await fetchWeather();
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(fresh)); } catch {}
    return fresh;
  } catch (err) {
    if (cached) return { ...cached, stale: true };
    throw err;
  }
}

function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)); } catch { return null; }
}

async function fetchWeather() {
  const lat = (k) => POINTS.map((p) => p[k][0]).join(',');
  const lon = (k) => POINTS.map((p) => p[k][1]).join(',');
  const common = 'timezone=Europe%2FCopenhagen&past_days=3&forecast_days=6';
  const wxUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat('wx')}&longitude=${lon('wx')}&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day,temperature_2m&wind_speed_unit=ms&${common}`;
  const seaUrl = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat('sea')}&longitude=${lon('sea')}&hourly=wave_height,wave_direction,sea_level_height_msl&${common}`;
  const [wx, sea] = await Promise.all([getJson(wxUrl), getJson(seaUrl)]);
  const wxs = Array.isArray(wx) ? wx : [wx];
  const seas = Array.isArray(sea) ? sea : [sea];

  const series = wxs.map((w, n) => {
    const h = w.hourly;
    const s = seas[n].hourly;
    const seaIdx = new Map(s.time.map((t, i) => [t, i]));
    const pick = (arr, t) => { const i = seaIdx.get(t); return i == null ? null : arr[i]; };
    return {
      time: h.time,
      ws: h.wind_speed_10m.map((v) => v ?? 0),
      wd: h.wind_direction_10m.map((v) => v ?? 0),
      gust: h.wind_gusts_10m,
      temp: h.temperature_2m,
      isDay: h.is_day,
      wave: h.time.map((t) => pick(s.wave_height, t)),
      waveDir: h.time.map((t) => pick(s.wave_direction, t)),
      sl: h.time.map((t) => pick(s.sea_level_height_msl, t)),
    };
  });
  return { fetchedAt: Date.now(), series };
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

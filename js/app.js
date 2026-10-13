import { scoreAt, levelOf, LEVELS, lowTides, MODEL_VERSION } from './model.js';
import { loadCoast, distance, bearing } from './spots.js';
import { cachedWeather, fetchWeather, hourKey } from './weather.js';
import * as store from './store.js';
import * as cloud from './sync.js';
import { createMap } from './mapview.js';

const $ = (id) => document.getElementById(id);
const COLORS = { green: '#3ddc84', yellow: '#ffc94d', red: '#ff5a4e' };
const DAYS = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør'];
const NEAR_KM = 30;
const APP_VERSION = 34; // samme nummer som cachen i sw.js
const DK = [[54.55, 8.0], [57.78, 12.75]];

const state = {
  spots: [], open: [], points: [], trapLines: [], weather: null, nowIdx: 0, selIdx: 0, ready: false,
  me: null, heading: null, scope: ['near', 'west', 'east', 'all'].includes(store.prefs().scope) ? store.prefs().scope : 'near',
  view: { tab: 'steder', spot: null, showAll: false },
  trip: null, watchId: null, wakeLock: null,
};

/* ---------- Kort ---------- */
const mv = createMap('map', { onSpotClick: (id) => openSpot(id), onDragStart: () => { lastPan = Date.now(); } });
let layerName = store.prefs().layer === 'foto' ? 'foto' : 'kort';
mv.setLayer(layerName);
$('map').classList.toggle('foto', layerName === 'foto');
const inDK = (p) => p[0] > 54.3 && p[0] < 58 && p[1] > 7.6 && p[1] < 15.4;


/* Siden må ikke zoome som et website (Safari ignorerer user-scalable=no); kortet håndterer selv sine fingre */
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
let lastTouchEnd = 0;
document.addEventListener('touchend', (e) => {
  if (e.target.closest('#map')) return;
  const now = Date.now();
  if (now - lastTouchEnd < 300) e.preventDefault(); // ingen dobbelttryk-zoom uden for kortet
  lastTouchEnd = now;
}, { passive: false });

/* ---------- Opstart ---------- */
// Inde i den native iPhone-app kommer GPS'en fra appen – også i baggrunden under en tur
const NATIVE = !!(window.ravNative && window.webkit?.messageHandlers?.rav);
const native = (cmd, data = {}) => { try { window.webkit.messageHandlers.rav.postMessage({ cmd, ...data }); } catch {} };
// Haptik: 'selection' (valg), 'light'/'medium' (tryk), 'success' (noget er gemt)
function haptic(style = 'light') {
  if (NATIVE) native('haptic', { style });
  else if (navigator.vibrate) navigator.vibrate(style === 'success' ? [12, 40, 12] : 8);
}
if (NATIVE) installNativeGps();
else if (new URLSearchParams(location.search).has('demo')) installDemoGps();

// Erstatter browserens GPS med appens. Positioner fra baggrunden kommer samlet, når appen er fremme igen.
function installNativeGps() {
  const watchers = new Set();
  let last = null;
  const toPos = (f) => ({ coords: { latitude: f.lat, longitude: f.lon, accuracy: f.acc }, timestamp: f.t });
  window.__ravFixes = (fixes) => {
    if (!fixes.length) return;
    // Alle undtagen den sidste lægges kun i sporet; den sidste opdaterer kort, pil og lager én gang
    if (state.trip) for (const f of fixes.slice(0, -1)) addTrackPoint(toPos(f));
    last = toPos(fixes[fixes.length - 1]);
    watchers.forEach((cb) => cb(last));
  };
  window.__ravHeading = (h) => { state.heading = h; };
  const geo = {
    watchPosition: (ok) => { watchers.add(ok); if (last) ok(last); return ok; },
    clearWatch: (id) => watchers.delete(id),
    getCurrentPosition: (ok, fail) => {
      if (last && Date.now() - last.timestamp < 15000) return ok(last);
      const once = (p) => { watchers.delete(once); ok(p); };
      watchers.add(once);
      setTimeout(() => { if (watchers.delete(once)) (last ? ok(last) : fail?.()); }, 15000);
    },
  };
  Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true });
}
init();

// ?demo: en simuleret gåtur ved Søndervig, så appen kan afprøves uden at stå på stranden
function installDemoGps() {
  let t = 0;
  const pos = () => ({ coords: { latitude: 56.1085 - t * 0.0002, longitude: 8.1065 + Math.sin(t / 3) * 0.0002, accuracy: 6 }, timestamp: Date.now() });
  const geo = {
    getCurrentPosition: (ok) => setTimeout(() => ok(pos()), 100),
    watchPosition: (ok) => { ok(pos()); return setInterval(() => { t++; ok(pos()); }, 1500); },
    clearWatch: (id) => clearInterval(id),
  };
  Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true });
}

async function init() {
  $('modelVersion').textContent = MODEL_VERSION;
  updateNight();
  bindUi();
  setSheet('peek');
  store.askPersist();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
    // Når en ny version tager over, genindlæses appen én gang, så du ikke kører med blandede filer
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded && !state.trip) { reloaded = true; location.reload(); } });
  }

  const coast = await loadCoast();
  state.spots = coast.spots;
  state.open = coast.spots.filter((s) => s.open);
  state.points = coast.points;
  state.trapLines = coast.trapLines;
  drawCoast();
  const resumed = store.activeTrip();
  if (resumed) resumeTrip(resumed);
  startLocating();
  if (NATIVE) { $('btnPocket').hidden = true; native('ready'); }
  runSync();
  // Vis vejret fra sidst med det samme, og hent nyt i baggrunden
  const cached = cachedWeather(state.points);
  if (cached) useWeather(cached);
  refreshWeather();
  setInterval(() => refreshWeather(), 5 * 60 * 1000); // tjekker hvert 5. min, henter kun hvis vejret er over 30 min gammelt
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshWeather(); runSync();
      if (state.trip) { requestWakeLock(); getPosition().then((pos) => pos && onPosition(pos)); }
    }
  });
  window.addEventListener('online', () => { refreshWeather(); runSync(); });
}

async function refreshWeather(force = false) {
  if (!force && state.weather && Date.now() - state.weather.fetchedAt < 30 * 60 * 1000) { useWeather(state.weather); return; }
  state.weatherError = null;
  if (state.ready) renderVerdict();
  try {
    useWeather(await fetchWeather(state.points));
  } catch (err) {
    state.weatherError = err.message;
    clearTimeout(state.retryTimer);
    state.retryTimer = setTimeout(() => refreshWeather(true), 2 * 60 * 1000); // prøv selv igen om 2 min
    if (state.ready) { renderVerdict(); return; }
    $('vDot').className = 'dot red';
    $('vTitle').textContent = 'Kunne ikke hente vejret';
    $('vSub').innerHTML = `${esc(err.message)} – prøver igen om 2 min · <button class="retry" id="btnRetry">Prøv nu</button>`;
    $('btnRetry').onclick = () => { $('vTitle').textContent = 'Henter vejret …'; $('vSub').textContent = 'Et øjeblik'; refreshWeather(true); };
  }
}

// Tag et vejrsæt i brug (fra telefonen eller nyhentet) og opdatér det hele
function useWeather(w) {
  state.weather = w;
  const times = w.series[0].time;
  const idx = times.indexOf(hourKey());
  const followNow = state.selIdx === state.nowIdx || !state.ready;
  state.nowIdx = idx >= 0 ? idx : 0;
  if (followNow) state.selIdx = state.nowIdx;
  state.ready = true;
  renderAll();
  updateNight();
}

/* ---------- Score (beregnes først, når den skal bruges, og huskes til vejret skifter) ---------- */
const wFor = (spot) => state.weather.series[spot.point];
function fresh(spot) { if (spot._sw !== state.weather) { spot._sw = state.weather; spot._s = []; spot._b = new Int16Array(state.weather.series[0].time.length).fill(-1); } }
// Fuld vurdering med forklaringer
function score(spot, i) { fresh(spot); return spot._s[i] || (spot._s[i] = scoreAt(wFor(spot), i, spot)); }
// Kun tallet – til kortets farver, tidslinjen og sortering
function quick(spot, i) { fresh(spot); if (spot._b[i] < 0) spot._b[i] = scoreAt(wFor(spot), i, spot, true); return spot._b[i]; }

// Hvilke strækninger listen, tidslinjen og dommen øverst handler om
function scopeSpots() {
  if (state.scope === 'west' || state.scope === 'east') { const r = state.scope === 'west' ? 'v' : 'o'; return state.open.filter((s) => s.region === r); }
  if (state.scope === 'near' && state.me) {
    const near = state.open.filter((s) => distance(state.me, s.center) < NEAR_KM * 1000);
    if (near.length) return near;
  }
  return state.open; // hele landet – også når Nær mig mangler position eller ravkyst
}
function scopeLabel() {
  if (state.scope === 'near' && state.me && state.open.some((s) => distance(state.me, s.center) < NEAR_KM * 1000)) return `inden for ${NEAR_KM} km`;
  if (state.scope === 'west') return 'i Vest';
  if (state.scope === 'east') return 'i Øst';
  return 'i hele landet';
}

/* ---------- Render ---------- */
const SCOPES = ['near', 'west', 'east', 'all'];
function renderScopes() {
  const el = $('scopes');
  if (!el.querySelector('.thumb')) el.innerHTML = `<span class="thumb" aria-hidden="true"></span>${scopeChips()}`;
  el.querySelectorAll('[data-scope]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scope === state.scope)));
  el.style.setProperty('--i', SCOPES.indexOf(state.scope));
}

function renderAll() {
  if (!state.ready) return;
  renderScopes();
  state._top = topScores();
  renderVerdict();
  renderTimeline();
  colorCoast();
  renderPanel();
  setSheet($('sheet').dataset.state); // tidslinjen giver det sammenfoldede ark sin højde
}
const renderScope = debounce(() => { if (!state.ready) return; state._top = topScores(); renderVerdict(); renderTimeline(); if (!state.view.spot) $('tab-steder').innerHTML = spotListHtml(); }, 250);

// Sorteret efter score; forklaringerne (r) hentes først for de rækker, der vises
function ranked(i = state.selIdx) {
  return scopeSpots()
    .map((spot) => ({ spot, q: quick(spot, i), d: state.me ? distance(state.me, spot.center) : null, get r() { return score(spot, i); } }))
    .sort((a, b) => b.q - a.q || (a.d ?? 0) - (b.d ?? 0));
}

function renderVerdict() {
  const best = ranked()[0];
  if (!best) return;
  const i = state.selIdx;
  const w = wFor(best.spot);
  const dark = w.isDay[i] === 0;
  $('vDot').className = `dot ${best.r.level}`;
  const when = i === state.nowIdx ? 'Lige nu' : timeLabel(w.time[i]);
  $('vEyebrow').textContent = `${when} · ${scopeLabel()}`;
  $('vTitle').textContent = LEVELS[best.r.level].label;
  $('vTitle').className = best.r.level;
  const next = nextWindow();
  const bits = [];
  if (best.r.level === 'green') bits.push(`Bedst: ${best.spot.name}`);
  bits.push(windText(w.ws[i], w.wd[i]));
  bits.push(dark ? 'mørkt' : 'lyst');
  let sub = bits.join(' · ');
  if (best.r.level !== 'green' && next) sub = `Næste gode tur: ${timeLabel(w.time[next.start])} · ${sub}`;
  const age = Date.now() - state.weather.fetchedAt;
  if (state.weatherError || age > 60 * 60 * 1000) sub = `Vejr fra ${clock(state.weather.fetchedAt)} – kunne ikke opdatere · ${sub}`;
  $('vSub').textContent = sub;
  $('btnNow').hidden = i === state.nowIdx;
}

function topScores() {
  const spots = scopeSpots();
  const n = state.weather.series[0].time.length;
  const start = Math.max(0, state.nowIdx - 6);
  const top = new Array(n).fill(0);
  for (let i = start; i < n; i++) {
    let m = 0;
    for (const s of spots) { const v = quick(s, i); if (v > m) m = v; }
    top[i] = m;
  }
  return top;
}

// Første sammenhængende grønne vindue fra nu
function nextWindow(top = state._top) {
  if (!top) return null;
  let best = null;
  for (let i = state.nowIdx; i < top.length; i++) {
    if (levelOf(top[i]) === 'green') {
      if (!best) best = { start: i, end: i };
      else if (i === best.end + 1) best.end = i;
      else break;
    }
  }
  return best;
}

function renderTimeline() {
  const el = $('timeline');
  const s0 = state.weather.series[0];
  const n = s0.time.length;
  const start = Math.max(0, state.nowIdx - 6);
  const top = state._top || (state._top = topScores());
  const groups = new Map();
  for (let i = start; i < n; i++) {
    const day = s0.time[i].slice(0, 10);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(i);
  }
  const html = [];
  for (const [day, idxs] of groups) {
    const d = new Date(`${day}T12:00`);
    const isToday = day === s0.time[state.nowIdx].slice(0, 10);
    html.push(`<div class="day"><div class="dayLabel">${isToday ? '<b>I dag</b>' : `${DAYS[d.getDay()]} ${d.getDate()}.`}</div><div class="hours">`);
    for (const i of idxs) {
      const lvl = levelOf(top[i]);
      const cls = ['h', lvl, s0.isDay[i] === 0 ? 'dark' : '', i === state.selIdx ? 'sel' : '', i < state.nowIdx ? 'past' : ''].join(' ');
      html.push(`<button class="${cls}" data-i="${i}" aria-label="${timeLabel(s0.time[i])}: ${LEVELS[lvl].label}"><i style="height:${Math.max(10, top[i])}%;--d:${Math.min(i - start, 40) * 8}ms"></i></button>`);
    }
    html.push('</div></div>');
  }
  el.innerHTML = html.join('');
  el.classList.remove('grow'); void el.offsetWidth; el.classList.add('grow');
  const sel = el.querySelector('.sel');
  if (sel && !el.dataset.scrolled) { sel.scrollIntoView({ inline: 'start', block: 'nearest' }); el.dataset.scrolled = '1'; }
}

/* Kysten tegnes én gang; farverne skiftes, når tidspunktet skifter */
/* Kysten tegnes én gang; farverne skiftes, når tidspunktet skifter */
function drawCoast() { mv.setCoast(state.spots, state.trapLines); }

function colorCoast() {
  renderBest();
  const region = state.scope === 'west' ? 'v' : state.scope === 'east' ? 'o' : null;
  const near = state.scope === 'near' ? new Set(scopeSpots()) : null;
  const items = [];
  state.spots.forEach((spot, i) => {
    if (!spot.open) return;
    const show = !region || spot.region === region;
    spot._in = show && (!near || near.has(spot));
    if (show) items.push({ i, on: spot._in, color: COLORS[levelOf(quick(spot, state.selIdx))] });
  });
  mv.styleCoast(items, region);
}

/* ---------- De tre bedste steder som nummererede markører ---------- */
function move(p, brg, m) {
  const lat = p[0] + (m * Math.cos((brg * Math.PI) / 180)) / 110574;
  const lon = p[1] + (m * Math.sin((brg * Math.PI) / 180)) / (111320 * Math.cos((p[0] * Math.PI) / 180));
  return [lat, lon];
}
// Nærmeste høfde/mole ved strækningen (beregnes én gang)
function trapFor(spot) {
  if (spot._trap !== undefined) return spot._trap;
  let best = null, bd = Infinity;
  if (spot.traps) for (const ln of state.trapLines) for (const p of ln) { const d = distance(p, spot.center); if (d < bd) { bd = d; best = ln; } }
  return (spot._trap = best && bd < 1200 ? best : null);
}
// Konkret mål: ved roden af høfden på den side, strømmen samler materialet – ellers midt på strækningen
function target(spot, r) {
  const ln = trapFor(spot);
  if (!ln) return { pos: spot.center, where: 'midt på strækningen' };
  const toCoast = (p) => Math.min(...spot.line.map((q) => distance(p, q)));
  const root = ln.reduce((a, p) => (toCoast(p) < toCoast(a) ? p : a));
  if (Math.abs(r.f.drift) <= 20) return { pos: root, where: 'ved høfden' };
  const side = r.f.drift > 0 ? spot.normal + 90 : spot.normal - 90;
  return { pos: move(root, side, 40), where: `på ${compass(side, true)}siden af høfden` };
}
function bestSpots() {
  const picked = [];
  for (const it of ranked()) {
    if (it.q < 30 || picked.length >= 3) break;
    if (picked.some((b) => distance(b.spot.center, it.spot.center) < 3000)) continue;
    const r = it.r;
    picked.push({ spot: it.spot, r, ...target(it.spot, r) });
  }
  return picked;
}
function renderBest() {
  if (!state.ready) return;
  state.best = bestSpots();
  mv.setBest(state.best.map((b) => ({ pos: b.pos, level: b.r.level, onClick: () => { haptic('light'); openSpot(b.spot.id); } })));
}

function renderPanel() {
  $('tab-steder').innerHTML = state.view.spot ? spotDetailHtml(state.view.spot) : spotListHtml();
  $('tab-ture').innerHTML = tripsHtml();
}

function scopeChips() {
  const chip = (key, label) => `<button class="scopeChip" data-scope="${key}" aria-pressed="${state.scope === key}">${label}</button>`;
  return `${chip('near', 'Nær mig')}${chip('west', 'Vest')}${chip('east', 'Øst')}${chip('all', 'Hele landet')}`;
}

function spotListHtml() {
  if (!state.ready) return '<p class="empty">Henter vejret …</p>';
  let note = '';
  if (state.scope === 'near' && !state.me) note = '<p class="mute small">Venter på din position – viser hele landet så længe.</p>';
  else if (state.scope === 'near' && !state.open.some((s) => distance(state.me, s.center) < NEAR_KM * 1000)) note = `<p class="mute small">Ingen ravkyst inden for ${NEAR_KM} km – viser hele landet.</p>`;
  const list = ranked();
  const shown = state.view.showAll ? list : list.slice(0, 8);
  const rows = shown.map(({ spot, r, d }) => `
    <button class="spot" data-spot="${spot.id}">
      <span class="score ${r.level}">${r.score}</span>
      <span class="spotName">${(() => { const bi = (state.best || []).findIndex((b) => b.spot === spot); return bi >= 0 ? `<span class="rank">${bi + 1}</span>` : ''; })()}${esc(spot.name)}${spot.traps ? '<span class="trapTag">høfder</span>' : ''}<small>${esc(r.reasons[0])}</small></span>
      <span class="spotDist">${d != null ? distText(d) : ''}</span>
    </button>`).join('');
  const label = state.selIdx === state.nowIdx ? 'Bedst lige nu' : `Bedst ${timeLabel(state.weather.series[0].time[state.selIdx])}`;
  const anim = state.animateList ? ' rise' : '';
  state.animateList = false;
  return `${note}<div class="sectionLabel">${label} · ${list.length} strækninger</div><div class="list${anim}">${rows}</div>
    ${list.length > 8 ? `<button class="more" data-act="all">${state.view.showAll ? 'Vis færre' : `Vis alle ${list.length}`}</button>` : ''}`;
}

function spotDetailHtml(id) {
  const spot = state.spots.find((s) => s.id === id);
  const i = state.selIdx;
  const r = score(spot, i);
  const w = wFor(spot);
  const d = state.me ? distance(state.me, spot.center) : null;
  const lows = lowTides(w).filter((x) => x >= state.nowIdx).slice(0, 2).map((x) => `ca. ${timeLabel(w.time[x], true)}`);
  const bi = (state.best || []).findIndex((b) => b.spot === spot);
  const best = bi >= 0 ? state.best[bi] : null;
  const [lat, lon] = best ? best.pos : spot.center;
  const maxFetch = Math.max(...spot.fetch);
  return `<div class="detail">
    <button class="back" data-act="back">‹ Alle steder</button>
    <div class="detailHead"><span class="score ${r.level}">${r.score}</span><div><h3>${esc(spot.name)}</h3><span class="mute">${LEVELS[r.level].label}${d != null ? ` · ${distText(d)} herfra` : ''}</span></div></div>
    ${best ? `<div class="hint"><b>Markør ${bi + 1}</b> på kortet: gå ${esc(best.where)}.</div>` : ''}
    <ul class="reasons">${r.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <div class="facts">
      <div class="fact"><b>${fmt(w.ws[i])}</b><span>m/s ${compass(w.wd[i])}</span></div>
      <div class="fact"><b>${w.wave[i] != null ? fmt(w.wave[i]) : '–'}</b><span>m bølger</span></div>
      <div class="fact"><b>${w.sl[i] != null ? fmt(w.sl[i] * 100, 0) : '–'}</b><span>cm vandstand</span></div>
    </div>
    <p class="mute">Kysten vender mod ${compass(spot.normal, true)} med ${maxFetch >= 250 ? 'åbent hav' : `op til ${maxFetch} km åbent vand`} foran.${lows.length ? ` Lavvande ${lows.join(' og ')} (model).` : ''}</p>
    <a class="linkbtn" href="https://maps.apple.com/?daddr=${lat},${lon}&dirflg=d" target="_blank" rel="noopener">Vis vej i Kort</a>
  </div>`;
}

// Zoom kortet ind på en landsdel, så den fylder den synlige del mellem toplinje og bundark
function fitSpots(spots) {
  mv.fit(spots.map((s) => s.center), $('top').getBoundingClientRect().bottom, $('sheet').offsetHeight);
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function tripsHtml() {
  const all = store.trips();
  const calib = ['green', 'yellow', 'red'].map((lvl) => {
    const t = all.filter((x) => x.model?.level === lvl);
    const hours = t.reduce((s, x) => s + (x.durationMin || 0) / 60, 0);
    const finds = t.reduce((s, x) => s + (x.finds || 0), 0);
    return `<div><b>${hours > 0 ? fmt(finds / hours) : '–'}</b><span>fund/time når ${({ green: 'grøn', yellow: 'gul', red: 'rød' })[lvl]} · ${t.length} ${t.length === 1 ? 'tur' : 'ture'}</span></div>`;
  }).join('');
  const rows = all.map((t) => {
    const d = new Date(t.startedAt);
    const asking = state.view.confirmDelete === t.id;
    return `<div class="trip">
      <span class="bar ${t.model?.level || 'red'}"></span>
      <button class="tripMain" data-act="ask-delete" data-id="${t.id}" aria-label="Vælg turen for at slette den"><strong>${DAYS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1} kl. ${pad(d.getHours())}:${pad(d.getMinutes())}</strong>
        <small>${esc(t.model?.spotName || '')} · ${t.durationMin} min · ${distText(t.walkedM || 0)}${t.uv ? ' · UV' : ''}</small>
        ${t.note ? `<small>${esc(t.note)}</small>` : ''}</button>
      <div class="n">${t.finds}<small><br>fund</small></div>
      ${asking ? `<div class="tripDelete"><button data-act="keep">Behold</button><button class="yes" data-act="delete" data-id="${t.id}">Slet turen</button></div>` : ''}
    </div>`;
  }).join('');
  return `${syncHtml()}
    <div class="sectionLabel">Rammer modellen?</div>
    <div class="calib">${calib}</div>
    <div class="sectionLabel">Dine ture${all.length ? ' · tryk på en tur for at slette den' : ''}</div>
    ${rows || '<p class="empty">Ingen ture endnu. Tryk “Start tur her”, når du går ned til vandet – og log også turene uden fund.</p>'}
    <div class="tripActions">
      <button data-act="export">Del alle ture (JSON)</button>
    </div>`;
}

/* ---------- Synkronisering ---------- */
async function runSync() {
  if (!cloud.isSetUp()) return;
  state.syncing = true;
  if (state.view.tab === 'ture') $('tab-ture').innerHTML = tripsHtml();
  const r = await cloud.sync();
  state.syncing = false;
  state.syncResult = r;
  $('tab-ture').innerHTML = tripsHtml();
  if (r.ok && r.added) toast(`${r.added} ${r.added === 1 ? 'tur' : 'ture'} hentet fra Airtable`);
}

function syncHtml() {
  if (state.view.syncSetup) {
    return `<div class="syncCard">
      <strong>Gem turene i Airtable</strong>
      <p class="mute">To ting i Airtable, så klarer appen resten:</p>
      <ol class="steps">
        <li>Lav en tom base, der hedder <b>Ravjagt</b>.</li>
        <li>Åbn <a href="https://airtable.com/create/tokens" target="_blank" rel="noopener">Airtable → Builder hub → Personal access tokens</a> og opret en nøgle med disse fire rettigheder: <b>data.records:read</b>, <b>data.records:write</b>, <b>schema.bases:read</b> og <b>schema.bases:write</b>. Under <b>Access</b> vælger du basen <b>Ravjagt</b>. Kopiér nøglen.</li>
      </ol>
      <label class="field"><span>Indsæt nøglen her</span>
        <input id="syncToken" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="pat…"></label>
      ${state.view.syncError ? `<p class="danger">${esc(state.view.syncError)}</p>` : ''}
      <div class="row"><button class="ghost" data-act="sync-cancel">Annullér</button><button class="primary" data-act="sync-save">Forbind</button></div>
      <p class="mute small">Appen opretter selv tabellen "Ture". Nøglen gemmes kun på denne telefon.</p>
    </div>`;
  }
  if (!cloud.isSetUp()) {
    return `<button class="syncCard off" data-act="sync-setup"><strong>Turene ligger kun på telefonen</strong><span class="mute">Tryk for at gemme dem i Airtable</span></button>`;
  }
  const c = cloud.config();
  const waiting = store.outbox().length;
  let line;
  if (state.syncing) line = 'Synkroniserer …';
  else if (state.syncResult && !state.syncResult.ok) line = `Ikke synket: ${state.syncResult.msg || 'ingen forbindelse'}${waiting ? ` · ${waiting} venter` : ''}`;
  else if (waiting) line = `${waiting} ${waiting === 1 ? 'ændring venter' : 'ændringer venter'} på net`;
  else line = c.lastSync ? `Synket ${clock(c.lastSync)} · ${c.remoteCount ?? 0} ${c.remoteCount === 1 ? 'tur' : 'ture'} i basen “${c.baseName}”, tabellen “Ture”` : `Forbundet til basen “${c.baseName}”`;
  const ok = !waiting && (!state.syncResult || state.syncResult.ok);
  return `<div class="syncCard ${ok ? 'on' : 'warn2'}">
    <div><strong>${ok ? 'Gemt i Airtable' : 'Synkronisering'}</strong><span class="mute">${esc(line)}</span></div>
    <button class="syncNow" data-act="sync-now" ${state.syncing ? 'disabled' : ''}>Synk nu</button>
  </div>`;
}

function clock(ms) {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return `${today ? 'i dag' : `${d.getDate()}/${d.getMonth() + 1}`} kl. ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------- Position ---------- */
function startLocating() {
  if (!navigator.geolocation) return;
  state.watchId = navigator.geolocation.watchPosition(onPosition, () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}

let firstFix = true;
function onPosition(pos) {
  const { latitude, longitude, accuracy } = pos.coords;
  state.me = [latitude, longitude];
  state.acc = accuracy;
  mv.setMe(state.me, accuracy);
  if (firstFix) {
    firstFix = false;
    // Er du i Danmark, starter kortet ved dig
    if (!state.trip && inDK(state.me)) focus(state.me, 11);
    if (state.ready) { renderScope(); if (state.scope === 'near') colorCoast(); }
  }
  if (state.trip) {
    onTripPosition(pos);
    // Kortet følger dig på turen, medmindre du selv har flyttet det inden for det sidste halve minut
    if (Date.now() - lastPan > 30000) focus(state.me);
  }
}

let lastPan = 0;

/* ---------- Tur ---------- */
async function startTrip() {
  askCompass();
  const pos = state.me ? { coords: { latitude: state.me[0], longitude: state.me[1], accuracy: state.acc } } : await getPosition();
  if (!pos) { toast('Slå placering til for Safari for at kunne starte en tur'); return; }
  const start = [pos.coords.latitude, pos.coords.longitude];
  const i = state.nowIdx;
  const nearest = (state.open.length ? state.open : state.spots).reduce((a, b) => (distance(a.center, start) < distance(b.center, start) ? a : b));
  const r = state.ready ? score(nearest, i) : null;
  const w = state.ready ? wFor(nearest) : null;
  state.trip = {
    id: `t${Date.now()}`, startedAt: new Date().toISOString(), start, startAcc: Math.round(pos.coords.accuracy),
    track: [[...start.map((x) => +x.toFixed(6)), Date.now()]], findPts: [],
    model: r ? {
      version: MODEL_VERSION, hour: w.time[i], spotId: nearest.id, spotName: nearest.name,
      score: r.score, level: r.level, f: r.f,
      wx: { ws: w.ws[i], wd: w.wd[i], gust: w.gust[i], wave: w.wave[i], sl: w.sl[i], isDay: w.isDay[i], temp: w.temp[i] },
    } : null,
  };
  store.setActiveTrip(state.trip);
  enterTripUi();
  focus(start, 16);
  haptic('success');
  toast('Start gemt. Pilen viser vej tilbage hertil.');
}

function resumeTrip(t) {
  state.trip = t;
  enterTripUi();
  focus(t.track.length ? [t.track[t.track.length - 1][0], t.track[t.track.length - 1][1]] : t.start, 15);
}

function enterTripUi() {
  if (NATIVE) native('startTrip');
  const t = state.trip;
  $('top').hidden = true;
  $('hud').hidden = false;
  $('sheet').classList.add('in-trip');
  setSheet('peek');
  $('actionsIdle').hidden = true;
  $('actionsTrip').hidden = false;
  mv.setTrip(t, trackParts(t.track));
  requestWakeLock();
  updateHud();
  clearInterval(state.hudTimer);
  state.hudTimer = setInterval(updateHud, 1000);
}

// Lægger et punkt i sporet (brug positionens eget tidspunkt – punkter fra baggrunden kommer senere)
function addTrackPoint(pos) {
  const t = state.trip;
  const p = [pos.coords.latitude, pos.coords.longitude];
  const ts = pos.timestamp || Date.now();
  const last = t.track[t.track.length - 1];
  if (ts <= last[2]) return false;
  const moved = distance([last[0], last[1]], p);
  if (pos.coords.accuracy < 50 && (moved > 8 || ts - last[2] > 20000)) {
    t.track.push([+p[0].toFixed(6), +p[1].toFixed(6), ts]);
    return true;
  }
  return false;
}

function onTripPosition(pos) {
  addTrackPoint(pos);
  mv.updateTrack(trackParts(state.trip.track));
  store.setActiveTrip(state.trip);
  updateHud();
}

function updateHud() {
  const t = state.trip;
  if (!t) return;
  const mins = Math.floor((Date.now() - new Date(t.startedAt)) / 60000);
  $('hudTime').textContent = `${Math.floor(mins / 60)}:${pad(mins % 60)}`;
  $('hudFinds').textContent = `${t.findPts.length} fund`;
  if (!state.me) { $('hudDist').textContent = '–'; return; }
  const d = distance(state.me, t.start);
  const b = bearing(state.me, t.start);
  mv.setHome(state.me, t.start);
  $('hudDist').textContent = d < 15 ? 'Du er her' : distText(d);
  const rel = state.heading != null ? b - state.heading : b;
  $('arrow').style.transform = `rotate(${rel}deg)`;
  $('hudSub').textContent = state.heading != null
    ? 'til start · pilen følger telefonen'
    : `til start · mod ${compass(b, true)} (nord er op)`;
}

function addFind() {
  const t = state.trip;
  if (!state.me) { toast('Venter på din position …'); return; }
  const f = [+state.me[0].toFixed(6), +state.me[1].toFixed(6), Date.now()];
  t.findPts.push(f);
  store.setActiveTrip(t);
  addFindMarker(f);
  updateHud();
  haptic('success');
  toast(`Fund nr. ${t.findPts.length} gemt`, 'Fortryd', () => {
    t.findPts.pop();
    store.setActiveTrip(t);
    enterTripUi();
  });
}

function addFindMarker(f) {
  mv.addFind(f);
}

let findsCount = 0;
function openEnd() {
  const t = state.trip;
  findsCount = t.findPts.length;
  $('findsOut').textContent = findsCount;
  $('uvUsed').checked = state.weather ? state.weather.series[0].isDay[state.nowIdx] === 0 : false;
  $('note').value = '';
  const mins = Math.round((Date.now() - new Date(t.startedAt)) / 60000);
  $('endSummary').textContent = `${mins} min · ${distText(walked(t.track))} gået. Log også ture uden fund – de er lige så vigtige for modellen.`;
  $('endDlg').showModal();
  document.activeElement?.blur(); // ingen knap skal have fokus fra start – første tryk skal virke
}

function finishTrip() {
  const t = state.trip;
  const durationMin = Math.max(1, Math.round((Date.now() - new Date(t.startedAt)) / 60000));
  const done = {
    ...t, endedAt: new Date().toISOString(), durationMin, walkedM: Math.round(walked(t.track)),
    finds: findsCount, uv: $('uvUsed').checked, note: $('note').value.trim(),
  };
  store.saveTrip(done);
  leaveTripUi();
  switchTab('ture');
  renderPanel();
  haptic('success');
  toast(`Turen er gemt · ${done.finds} fund`);
  runSync();
}

// En testtur eller en fejlstart: intet gemmes, så statistikken ikke forurenes
function discardTrip() {
  leaveTripUi();
  renderPanel();
  toast('Turen er kasseret – intet gemt');
}

function leaveTripUi() {
  if (NATIVE) native('stopTrip');
  store.setActiveTrip(null);
  state.trip = null;
  clearInterval(state.hudTimer);
  releaseWakeLock();
  mv.setTrip(null);
  $('top').hidden = false;
  $('hud').hidden = true;
  $('actionsIdle').hidden = false;
  $('actionsTrip').hidden = true;
  $('sheet').classList.remove('in-trip');
  setSheet($('sheet').dataset.state);
}

// Huller i sporet (telefonen låst, ingen GPS i over 90 sek.) tegnes ikke som en lige streg og tælles ikke med
const GAP_MS = 90000;
function trackParts(track) {
  const parts = [[]];
  track.forEach((p, i) => {
    if (i && p[2] - track[i - 1][2] > GAP_MS) parts.push([]);
    parts[parts.length - 1].push([p[0], p[1]]);
  });
  return parts;
}
const walked = (track) => track.reduce((s, p, i) => (i && p[2] - track[i - 1][2] <= GAP_MS ? s + distance([track[i - 1][0], track[i - 1][1]], [p[0], p[1]]) : s), 0);

/* Lommetilstand: helt sort skærm, der holdes tændt, så GPS'en kører videre med telefonen i lommen.
   Sorte pixels bruger næsten ingen strøm på iPhones OLED-skærm. Hold fingeren nede i 2 sek. for at låse op. */
function enterPocket() {
  requestWakeLock();
  $('pocket').hidden = false;
  updatePocket();
  clearInterval(state.pocketTimer);
  state.pocketTimer = setInterval(updatePocket, 5000);
}
function exitPocket() {
  $('pocket').hidden = true;
  clearInterval(state.pocketTimer);
  updateHud();
}
function updatePocket() {
  const t = state.trip;
  if (!t) return exitPocket();
  const d = state.me ? distText(distance(state.me, t.start)) : '–';
  $('pocketInfo').textContent = `GPS kører · ${t.track.length} punkter · ${d} til start`;
}
function bindPocket() {
  const el = $('pocket');
  let timer = null;
  const ring = $('pocketRing');
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    ring.classList.add('holding');
    timer = setTimeout(() => { ring.classList.remove('holding'); exitPocket(); }, 2000);
  });
  const cancel = () => { clearTimeout(timer); ring.classList.remove('holding'); };
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerleave', cancel);
}

function getPosition() {
  return new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(res, () => res(null), { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}

/* Kompas: iOS kræver tilladelse fra et tryk */
let compassOn = false;
async function askCompass() {
  if (NATIVE) return; // kompasretningen kommer fra appen
  if (compassOn) return;
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') return;
    }
  } catch { return; }
  compassOn = true;
  const handler = (e) => {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
    else if (e.absolute && typeof e.alpha === 'number') h = (360 - e.alpha) % 360;
    if (h != null) { state.heading = h; }
  };
  window.addEventListener('deviceorientationabsolute', handler);
  window.addEventListener('deviceorientation', handler);
}

async function requestWakeLock() {
  try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
function releaseWakeLock() { try { state.wakeLock?.release(); } catch {} state.wakeLock = null; }

/* ---------- UI ---------- */
function bindUi() {
  $('timeline').addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b || +b.dataset.i === state.selIdx) return;
    state.selIdx = +b.dataset.i;
    $('timeline').querySelector('.sel')?.classList.remove('sel');
    b.classList.add('sel');
    haptic('selection');
    renderVerdict(); colorCoast(); renderPanel();
  });
  $('btnNow').addEventListener('click', () => {
    state.selIdx = state.nowIdx;
    delete $('timeline').dataset.scrolled;
    renderAll();
  });
  $('tab-steder').addEventListener('click', (e) => {
    const s = e.target.closest('[data-spot]');
    if (s) return openSpot(s.dataset.spot);
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'back') { state.view.spot = null; renderPanel(); }
    if (a.dataset.act === 'all') { state.view.showAll = !state.view.showAll; renderPanel(); }
  });
  $('scopes').addEventListener('click', (e) => {
    const c = e.target.closest('[data-scope]');
    if (!c) return;
    if (c.dataset.scope === state.scope) return;
    state.scope = c.dataset.scope;
    state.view.showAll = false;
    state.view.spot = null; // tilbage til listen
    haptic('selection');
    state.animateList = true;
    store.setPrefs({ scope: state.scope });
    if (state.scope === 'near' && state.me) focus(state.me, 11);
    // Bornholm tæller med i Øst, men kortet zoomer på Sjælland og øerne, så de ikke bliver små
    if (state.scope === 'west' || state.scope === 'east') fitSpots(scopeSpots());
    if (state.scope === 'all') fitSpots(state.open);
    state._top = topScores();
    renderScopes(); renderVerdict(); renderTimeline(); colorCoast(); renderPanel();
  });
  $('tab-ture').addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    if (a.dataset.act === 'export') shareExport();
    if (a.dataset.act === 'ask-delete') state.view.confirmDelete = a.dataset.id;
    if (a.dataset.act === 'keep') state.view.confirmDelete = null;
    if (a.dataset.act === 'delete') {
      store.deleteTrip(a.dataset.id);
      state.view.confirmDelete = null;
      toast('Turen er slettet');
      runSync();
    }
    if (a.dataset.act === 'sync-setup') { state.view.syncSetup = true; state.view.syncError = null; }
    if (a.dataset.act === 'sync-cancel') state.view.syncSetup = false;
    if (a.dataset.act === 'sync-now') { runSync(); return; }
    if (a.dataset.act === 'sync-save') { connectSync(); return; }
    $('tab-ture').innerHTML = tripsHtml();
  });
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  bindSheetDrag();
  bindSlide();
  $('btnFind').addEventListener('click', addFind);
  $('btnEnd').addEventListener('click', openEnd);
  $('btnPocket').addEventListener('click', enterPocket);
  bindPocket();
  $('finds-minus').addEventListener('click', () => { findsCount = Math.max(0, findsCount - 1); $('findsOut').textContent = findsCount; });
  $('finds-plus').addEventListener('click', () => { findsCount++; $('findsOut').textContent = findsCount; });
  $('endDlg').addEventListener('close', () => {
    const v = $('endDlg').returnValue;
    if (v === 'save') finishTrip();
    if (v === 'discard') discardTrip();
  });
  $('btnLocate').addEventListener('click', () => {
    lastPan = 0;
    if (state.me) focus(state.me, Math.max(mv.getZoom(), 15));
    else toast('Venter på din position – tillad placering for Safari');
    askCompass();
  });
  $('btnLayer').addEventListener('click', () => {
    layerName = layerName === 'kort' ? 'foto' : 'kort';
    mv.setLayer(layerName);
    $('map').classList.toggle('foto', layerName === 'foto');
    store.setPrefs({ layer: layerName });
    haptic('selection');
  });
  $('btnNight').addEventListener('click', () => {
    const order = ['auto', 'on', 'off'];
    const next = order[(order.indexOf(nightMode()) + 1) % 3];
    store.setPrefs({ night: next });
    updateNight();
    haptic('selection');
    toast({ auto: 'Dæmpet om aftenen: automatisk', on: 'Dæmpet: altid', off: 'Dæmpet: aldrig' }[next]);
  });
}

/* Swipe for at starte tur: knappen trækkes mod højre. Et tryk alene starter ikke en tur (heller ikke i lommen). */
function bindSlide() {
  const track = $('slideStart'), knob = $('slideKnob');
  let x0 = null, dx = 0, max = 0, armed = false;
  const set = (x) => { dx = x; track.style.setProperty('--x', `${x}px`); track.style.setProperty('--p', max ? x / max : 0); };
  track.addEventListener('pointerdown', (e) => {
    max = track.clientWidth - knob.offsetWidth - 8;
    x0 = e.clientX - dx; armed = false;
    track.setPointerCapture(e.pointerId); track.classList.add('dragging');
  });
  track.addEventListener('pointermove', (e) => {
    if (x0 === null) return;
    set(Math.max(0, Math.min(max, e.clientX - x0)));
    if (!armed && dx > max * 0.8) { armed = true; haptic('light'); }
    if (armed && dx < max * 0.8) armed = false;
  });
  const end = () => {
    if (x0 === null) return;
    x0 = null; track.classList.remove('dragging');
    if (dx > max * 0.8) {
      set(max);
      startTrip();
      setTimeout(() => set(0), 600);
    } else {
      if (dx < 6) { track.classList.remove('nudge'); void track.offsetWidth; track.classList.add('nudge'); toast('Swipe knappen mod højre for at starte'); }
      set(0);
    }
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
  track.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startTrip(); } });
}

function openSpot(id) {
  state.view.spot = id;
  switchTab('steder');
  if ($('sheet').dataset.state === 'peek') setSheet('mid');
  renderPanel();
  const spot = state.spots.find((s) => s.id === id);
  const best = (state.best || []).find((b) => b.spot === spot);
  focus(best ? best.pos : spot.center, Math.max(mv.getZoom(), 14)); // zoom ind, så høfden og vejen kan ses
}

function switchTab(tab) {
  if (state.view.tab === tab && $('sheet').dataset.state === 'peek') setSheet('mid');
  if (state.view.tab !== tab) haptic('selection');
  state.view.tab = tab;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelector('.tabs').style.setProperty('--i', ['steder', 'ture', 'info'].indexOf(tab));
  ['steder', 'ture', 'info'].forEach((t) => { $(`tab-${t}`).hidden = t !== tab; });
}

/* iOS-hjemmeskærmsapp (set på iOS 27): dokumentets højde (clientHeight) kan være statuslinjens højde
   kortere end vinduet (innerHeight). Alt, der står fast i bunden, følger den korte højde, og under det
   tegner iOS en solid bjælke. Vi måler netop den forskel, gør dokumentet lige så højt som vinduet og
   flytter kort og ark ned med forskellen. Uden forskel gør vi ingenting. */
function isStandalone() { return !!(navigator.standalone || matchMedia('(display-mode: standalone)').matches); }
// Hvor meget vinduet mangler i forhold til skærmen (iOS-fejlen: ca. statuslinjens højde)
function missing() {
  if (!isStandalone() || window.innerWidth > window.innerHeight) return 0;
  const d = Math.max(screen.height - window.innerHeight, window.innerHeight - document.documentElement.clientHeight);
  return d > 10 && d < 160 ? d : 0;
}
var lastFix = 'ingen'; // var: kan læses, før linjen er kørt
function fixViewport() {
  const root = document.documentElement;
  root.classList.toggle('standalone', isStandalone());
  root.style.height = '';
  root.style.setProperty('--gap', '0px');
  let d = missing();
  if (d) {
    // 1) Få iOS til at måle forfra: skjul og vis siden i samme øjeblik (kendt rettelse af fejlen)
    document.body.style.display = 'none';
    void document.body.offsetHeight;
    document.body.style.display = '';
    const after = missing();
    lastFix = after ? `målt forfra uden effekt, flytter ${after}` : `målt forfra – vinduet er nu ${window.innerHeight}`;
    d = after;
  } else lastFix = 'ingen nødvendig';
  // 2) Mangler der stadig noget: gør siden lige så høj som skærmen og flyt kort og ark ned
  if (d) {
    root.style.height = `${window.innerHeight + d}px`;
    root.style.setProperty('--gap', `${d}px`);
  }
  if (typeof mv !== 'undefined') mv.resize();
  if ($('sheet').dataset.state) setSheet($('sheet').dataset.state);
  if ($('screenInfo')) $('screenInfo').textContent = screenInfo();
}
function screenInfo() {
  const sa = (side) => { const el = document.createElement('div'); el.style.cssText = `position:fixed;visibility:hidden;height:env(safe-area-inset-${side})`; document.body.append(el); const h = el.offsetHeight; el.remove(); return h; };
  return `App v${APP_VERSION} · Skærm ${screen.width}×${screen.height} · vindue ${window.innerHeight} · dokument ${document.documentElement.clientHeight} · top ${sa('top')} · bund ${sa('bottom')} · rettelse: ${lastFix} · ${NATIVE ? 'iPhone-app' : isStandalone() ? 'hjemmeskærm' : 'browser'}`;
}
fixViewport();
for (const ev of ['resize', 'orientationchange', 'pageshow']) window.addEventListener(ev, () => setTimeout(fixViewport, 100));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(fixViewport, 150); });
document.addEventListener('focusout', (e) => { if (e.target.matches('input, textarea')) setTimeout(fixViewport, 300); });

/* Bundarket: sammenfoldet (tidslinje + knap), halvt eller næsten helt op. Træk eller tryk. */
function sheetHeights() {
  const sheet = $('sheet');
  const safe = parseFloat(getComputedStyle(sheet).paddingBottom) || 0;
  const tl = sheet.classList.contains('in-trip') ? 0 : $('timeline').offsetHeight + $('scopes').offsetHeight;
  const actions = ($('actionsTrip').hidden ? $('actionsIdle') : $('actionsTrip')).offsetHeight;
  // Sammenfoldet: filter, tidslinje, knap, fanerne og toppen af listen ("Bedst lige nu" + starten af første sted)
  const tabs = document.querySelector('.tabs').offsetHeight + 10;
  const listPeek = 72;
  const peek = $('grab').offsetHeight + tl + actions + tabs + listPeek + safe + 2;
  const vh = window.innerHeight + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gap')) || 0);
  return { peek, mid: Math.max(peek + 120, Math.round(vh * 0.5)), max: Math.round(vh * 0.86) };
}

function setSheetPx(px) {
  $('sheet').style.height = `${px}px`;
  document.documentElement.style.setProperty('--sheet-h', `${px}px`);
}

function setSheet(s) {
  $('sheet').dataset.state = s;
  setSheetPx(sheetHeights()[s]);
}

function bindSheetDrag() {
  const grab = $('grab');
  const sheet = $('sheet');
  let startY = 0, startH = 0, moved = false, dragging = false;
  grab.addEventListener('pointerdown', (e) => {
    dragging = true; moved = false; startY = e.clientY; startH = sheet.offsetHeight;
    grab.setPointerCapture(e.pointerId);
    sheet.classList.add('dragging');
  });
  grab.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 6) moved = true;
    const h = sheetHeights();
    setSheetPx(Math.min(h.max, Math.max(h.peek, startH - dy)));
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove('dragging');
    const h = sheetHeights();
    if (!moved) {
      const order = ['peek', 'mid', 'max'];
      haptic('light');
      setSheet(order[(order.indexOf(sheet.dataset.state) + 1) % 3]);
      return;
    }
    const cur = sheet.offsetHeight;
    const best = Object.entries(h).reduce((a, b) => (Math.abs(b[1] - cur) < Math.abs(a[1] - cur) ? b : a))[0];
    if (best !== sheet.dataset.state) haptic('light');
    setSheet(best);
  };
  grab.addEventListener('pointerup', end);
  grab.addEventListener('pointercancel', end);
  window.addEventListener('resize', () => setSheet(sheet.dataset.state));
}

// Centrér et punkt i den synlige del af kortet (mellem toplinjen og bundarket)
function focus(latlng, zoom) {
  const top = ($('hud').hidden ? $('top') : $('hud')).getBoundingClientRect().bottom;
  mv.focus(latlng, zoom, top, $('sheet').offsetHeight);
}

/* Natlys: dæmper hele skærmen (samme farver), så den lyser mindre om aftenen. 'auto' slår det til, når det er mørkt der, hvor du er. */
function nightMode() {
  const v = store.prefs().night;
  return v === 'on' || v === 'off' ? v : 'auto'; // tidligere true/false → automatisk
}
function isDarkNow() {
  if (!state.weather) return false;
  const pt = state.me && state.points.length
    ? state.points.reduce((b, p, k) => (distance(state.me, [p[0], p[1]]) < distance(state.me, [state.points[b][0], state.points[b][1]]) ? k : b), 0)
    : 0;
  return state.weather.series[pt]?.isDay[state.nowIdx] === 0;
}
function updateNight() {
  const mode = nightMode();
  const on = mode === 'on' || (mode === 'auto' && isDarkNow());
  document.body.classList.toggle('night', on);
  $('btnNight').setAttribute('aria-pressed', String(on));
  $('btnNight').dataset.mode = mode;
  $('btnNight').setAttribute('aria-label', `Natlys: ${{ auto: 'automatisk', on: 'altid til', off: 'altid fra' }[mode]}`);
  mv.setNight(on);
}

async function connectSync() {
  const token = $('syncToken').value;
  if (!token.trim()) { state.view.syncError = 'Indsæt nøglen først.'; $('tab-ture').innerHTML = tripsHtml(); return; }
  const btn = document.querySelector('[data-act="sync-save"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Tjekker …'; }
  const r = await cloud.setUp(token);
  if (!r.ok) { state.view.syncError = r.msg; $('tab-ture').innerHTML = tripsHtml(); return; }
  state.view.syncSetup = false;
  toast(`Forbundet til ${r.baseName} – dine ture gemmes nu i Airtable`);
  runSync();
}

async function shareExport() {
  const json = store.exportAll();
  const file = new File([json], `ravjagt-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: 'Ravjagt – ture' }); return; }
  } catch (e) { if (e?.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(json); toast('Turene er kopieret'); } catch { toast('Kunne ikke dele – prøv fra Safari'); }
}

let toastTimer;
function toast(msg, actionLabel, action) {
  const el = $('toast');
  el.innerHTML = `<span>${esc(msg)}</span>${actionLabel ? `<button>${esc(actionLabel)}</button>` : ''}`;
  el.hidden = false;
  el.classList.remove('out');
  const hide = () => { el.classList.add('out'); setTimeout(() => { if (el.classList.contains('out')) el.hidden = true; }, 260); };
  if (action) el.querySelector('button').onclick = () => { action(); hide(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hide, actionLabel ? 5000 : 3000);
}

/* ---------- Format ---------- */
function fmt(x, dec) { const d = dec ?? (Math.abs(x) < 10 ? 1 : 0); return x.toFixed(d).replace('.', ','); }
function pad(n) { return String(n).padStart(2, '0'); }
function distText(m) { return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${fmt(m / 1000)} km`; }
function timeLabel(t, short) {
  const d = new Date(t);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(t.slice(0, 10) + 'T00:00') - today) / 86400000);
  const day = diff === 0 ? 'i dag' : diff === 1 ? 'i morgen' : diff === -1 ? 'i går' : DAYS[d.getDay()];
  return short ? `${day} kl. ${pad(d.getHours())}` : `${day} kl. ${pad(d.getHours())}:00`;
}
function compass(deg, long) {
  const s = ['N', 'NØ', 'Ø', 'SØ', 'S', 'SV', 'V', 'NV'];
  const l = ['nord', 'nordøst', 'øst', 'sydøst', 'syd', 'sydvest', 'vest', 'nordvest'];
  const k = Math.round(deg / 45) % 8;
  return long ? l[k] : s[k];
}
function windText(ws, wd) { return `${fmt(ws)} m/s fra ${compass(wd, true)}`; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

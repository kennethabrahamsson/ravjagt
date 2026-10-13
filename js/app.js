import { scoreAt, levelOf, LEVELS, lowTides, MODEL_VERSION } from './model.js';
import { loadCoast, distance, bearing } from './spots.js';
import { cachedWeather, fetchWeather, hourKey } from './weather.js';
import * as store from './store.js';
import * as cloud from './sync.js';

const $ = (id) => document.getElementById(id);
const COLORS = { green: '#43d17f', yellow: '#f2c14e', red: '#e5574f' };
const DAYS = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør'];
const NEAR_KM = 30;
const APP_VERSION = 20; // samme nummer som cachen i sw.js
const DK = [[54.55, 8.0], [57.78, 12.75]];

const state = {
  spots: [], open: [], points: [], trapLines: [], weather: null, nowIdx: 0, selIdx: 0, ready: false,
  me: null, heading: null, scope: ['near', 'west', 'east', 'all'].includes(store.prefs().scope) ? store.prefs().scope : 'near',
  view: { tab: 'steder', spot: null, showAll: false },
  trip: null, watchId: null, wakeLock: null,
};

/* ---------- Kort ---------- */
const canvas = L.canvas({ padding: 0.3, tolerance: 8 });
const map = L.map('map', { zoomControl: false, attributionControl: false, renderer: canvas, preferCanvas: true }).fitBounds(DK);
L.control.attribution({ position: 'bottomleft', prefix: false }).addTo(map);
const layers = {
  kort: L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, maxNativeZoom: 16, attribution: 'Kort © Esri, HERE, Garmin, © OpenStreetMap',
    }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, maxNativeZoom: 16,
    }),
  ]),
  foto: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Luftfoto © Esri',
  }),
};
let layerName = store.prefs().layer === 'foto' ? 'foto' : 'kort';
layers[layerName].addTo(map);

const coastLayer = L.layerGroup().addTo(map);
const trapLayer = L.layerGroup();
const tripLayer = L.layerGroup().addTo(map);
let meMarker = null, meCircle = null, homeLine = null, trackLine = null;

/* ---------- Opstart ---------- */
if (new URLSearchParams(location.search).has('demo')) installDemoGps();
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
  applyNight(store.prefs().night);
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
  runSync();
  // Vis vejret fra sidst med det samme, og hent nyt i baggrunden
  const cached = cachedWeather(state.points);
  if (cached) useWeather(cached);
  refreshWeather();
  setInterval(() => refreshWeather(), 5 * 60 * 1000); // tjekker hvert 5. min, henter kun hvis vejret er over 30 min gammelt
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { refreshWeather(); runSync(); if (state.trip) requestWakeLock(); }
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
function renderScopes() { $('scopes').innerHTML = scopeChips(); }

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
  $('vTitle').textContent = `${when}: ${LEVELS[best.r.level].label.toLowerCase()} ${scopeLabel()}`;
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
      html.push(`<button class="${cls}" data-i="${i}" aria-label="${timeLabel(s0.time[i])}: ${LEVELS[lvl].label}"><i style="height:${Math.max(10, top[i])}%"></i></button>`);
    }
    html.push('</div></div>');
  }
  el.innerHTML = html.join('');
  const sel = el.querySelector('.sel');
  if (sel && !el.dataset.scrolled) { sel.scrollIntoView({ inline: 'start', block: 'nearest' }); el.dataset.scrolled = '1'; }
}

/* Kysten tegnes én gang; farverne skiftes, når tidspunktet skifter */
function drawCoast() {
  coastLayer.clearLayers();
  for (const spot of state.spots) {
    if (spot.open) {
      spot.layer = L.polyline(spot.line, { color: '#5b6b70', weight: lineWeight(), opacity: 0.95, lineCap: 'butt' })
        .on('click', () => openSpot(spot.id)).addTo(coastLayer);
    } else {
      spot.layer = L.polyline(spot.line, { color: '#6f8086', weight: 1.2, opacity: 0.35, interactive: false }).addTo(coastLayer);
    }
  }
  for (const ln of state.trapLines) L.polyline(ln, { color: '#e8eef0', weight: 2, opacity: 0.8, interactive: false }).addTo(trapLayer);
  map.on('zoomend', () => {
    const w = lineWeight();
    for (const s of state.open) s.layer.setStyle({ weight: s._in === false ? Math.max(1.5, w / 3) : w });
    if (map.getZoom() >= 13) trapLayer.addTo(map); else map.removeLayer(trapLayer);
  });
}
const lineWeight = () => { const z = map.getZoom(); return z >= 13 ? 9 : z >= 11 ? 7 : z >= 9 ? 5 : 3; };

// Vest/Øst: kun den landsdels kyst vises. Nær mig: kysten uden for 30 km bliver grå. Hele landet: alt.
function colorCoast() {
  const region = state.scope === 'west' ? 'v' : state.scope === 'east' ? 'o' : null;
  const near = state.scope === 'near' ? new Set(scopeSpots()) : null;
  const w = lineWeight();
  for (const spot of state.spots) {
    const show = !region || spot.region === region;
    if (show !== coastLayer.hasLayer(spot.layer)) show ? coastLayer.addLayer(spot.layer) : coastLayer.removeLayer(spot.layer);
    if (!spot.open || !show) continue;
    spot._in = !near || near.has(spot);
    spot.layer.setStyle(spot._in
      ? { color: COLORS[levelOf(quick(spot, state.selIdx))], opacity: 0.95, weight: w }
      : { color: '#6f8086', opacity: 0.4, weight: Math.max(1.5, w / 3) });
  }
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
      <span class="spotName">${esc(spot.name)}${spot.traps ? '<span class="trapTag">høfder</span>' : ''}<small>${esc(r.reasons[0])}</small></span>
      <span class="spotDist">${d != null ? distText(d) : ''}</span>
    </button>`).join('');
  const label = state.selIdx === state.nowIdx ? 'Bedst lige nu' : `Bedst ${timeLabel(state.weather.series[0].time[state.selIdx])}`;
  return `${note}<div class="sectionLabel">${label} · ${list.length} strækninger</div><div class="list">${rows}</div>
    ${list.length > 8 ? `<button class="more" data-act="all">${state.view.showAll ? 'Vis færre' : `Vis alle ${list.length}`}</button>` : ''}`;
}

function spotDetailHtml(id) {
  const spot = state.spots.find((s) => s.id === id);
  const i = state.selIdx;
  const r = score(spot, i);
  const w = wFor(spot);
  const d = state.me ? distance(state.me, spot.center) : null;
  const lows = lowTides(w).filter((x) => x >= state.nowIdx).slice(0, 2).map((x) => `ca. ${timeLabel(w.time[x], true)}`);
  const [lat, lon] = spot.center;
  const maxFetch = Math.max(...spot.fetch);
  return `<div class="detail">
    <button class="back" data-act="back">‹ Alle steder</button>
    <div class="detailHead"><span class="score ${r.level}">${r.score}</span><div><h3>${esc(spot.name)}</h3><span class="mute">${LEVELS[r.level].label}${d != null ? ` · ${distText(d)} herfra` : ''}</span></div></div>
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
  if (!spots.length) return;
  const b = L.latLngBounds(spots.map((s) => s.center));
  const top = $('top').getBoundingClientRect().bottom;
  map.fitBounds(b, { paddingTopLeft: [16, top + 12], paddingBottomRight: [60, $('sheet').offsetHeight + 12] });
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
  if (!meMarker) {
    meCircle = L.circle(state.me, { radius: accuracy, color: '#4aa3ff', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
    meMarker = L.marker(state.me, { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [18, 18] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
  } else {
    meMarker.setLatLng(state.me);
    meCircle.setLatLng(state.me).setRadius(accuracy);
  }
  if (firstFix) {
    firstFix = false;
    // Er du i Danmark, starter kortet ved dig
    if (!state.trip && L.latLngBounds(DK).pad(0.1).contains(state.me)) focus(state.me, 11);
    if (state.ready) { renderScope(); if (state.scope === 'near') colorCoast(); }
  }
  if (state.trip) {
    onTripPosition(pos);
    // Kortet følger dig på turen, medmindre du selv har flyttet det inden for det sidste halve minut
    if (Date.now() - lastPan > 30000) focus(state.me);
  }
}

let lastPan = 0;
map.on('dragstart', () => { lastPan = Date.now(); });

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
  toast('Start gemt. Pilen viser vej tilbage hertil.');
}

function resumeTrip(t) {
  state.trip = t;
  enterTripUi();
}

function enterTripUi() {
  const t = state.trip;
  $('top').hidden = true;
  $('hud').hidden = false;
  $('sheet').classList.add('trip');
  setSheet('peek');
  $('actionsIdle').hidden = true;
  $('actionsTrip').hidden = false;
  tripLayer.clearLayers();
  L.marker(t.start, { icon: L.divIcon({ className: '', html: '<div class="startPin"></div>', iconSize: [30, 30], iconAnchor: [15, 30] }), title: 'Start', zIndexOffset: 900 }).addTo(tripLayer);
  trackLine = L.polyline(t.track.map((p) => [p[0], p[1]]), { color: '#ffb23f', weight: 4, opacity: 0.85 }).addTo(tripLayer);
  homeLine = L.polyline([t.start, t.start], { color: '#ffb23f', weight: 2, dashArray: '6 8', opacity: 0.9, interactive: false }).addTo(tripLayer);
  t.findPts.forEach((f) => addFindMarker(f));
  requestWakeLock();
  updateHud();
  clearInterval(state.hudTimer);
  state.hudTimer = setInterval(updateHud, 1000);
}

function onTripPosition(pos) {
  const t = state.trip;
  const p = [pos.coords.latitude, pos.coords.longitude];
  const last = t.track[t.track.length - 1];
  const moved = distance([last[0], last[1]], p);
  if (pos.coords.accuracy < 50 && (moved > 8 || Date.now() - last[2] > 20000)) {
    t.track.push([+p[0].toFixed(6), +p[1].toFixed(6), Date.now()]);
    trackLine.addLatLng(p);
    store.setActiveTrip(t);
  }
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
  homeLine.setLatLngs([state.me, t.start]);
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
  if (navigator.vibrate) navigator.vibrate(30);
  toast(`Fund nr. ${t.findPts.length} gemt`, 'Fortryd', () => {
    t.findPts.pop();
    store.setActiveTrip(t);
    enterTripUi();
  });
}

function addFindMarker(f) {
  L.marker([f[0], f[1]], { icon: L.divIcon({ className: '', html: '<div class="findPin"></div>', iconSize: [12, 12] }), interactive: false }).addTo(tripLayer);
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
  store.setActiveTrip(null);
  state.trip = null;
  clearInterval(state.hudTimer);
  releaseWakeLock();
  tripLayer.clearLayers();
  $('top').hidden = false;
  $('hud').hidden = true;
  $('actionsIdle').hidden = false;
  $('actionsTrip').hidden = true;
  $('sheet').classList.remove('trip');
  setSheet($('sheet').dataset.state);
}

const walked = (track) => track.reduce((s, p, i) => (i ? s + distance([track[i - 1][0], track[i - 1][1]], [p[0], p[1]]) : 0), 0);

function getPosition() {
  return new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(res, () => res(null), { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}

/* Kompas: iOS kræver tilladelse fra et tryk */
let compassOn = false;
async function askCompass() {
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
    if (!b) return;
    state.selIdx = +b.dataset.i;
    renderVerdict(); renderTimeline(); colorCoast(); renderPanel();
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
    state.scope = c.dataset.scope;
    state.view.showAll = false;
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
  $('btnStart').addEventListener('click', startTrip);
  $('btnFind').addEventListener('click', addFind);
  $('btnEnd').addEventListener('click', openEnd);
  $('finds-minus').addEventListener('click', () => { findsCount = Math.max(0, findsCount - 1); $('findsOut').textContent = findsCount; });
  $('finds-plus').addEventListener('click', () => { findsCount++; $('findsOut').textContent = findsCount; });
  $('endDlg').addEventListener('close', () => {
    const v = $('endDlg').returnValue;
    if (v === 'save') finishTrip();
    if (v === 'discard') discardTrip();
  });
  $('btnLocate').addEventListener('click', () => {
    lastPan = 0;
    if (state.me) focus(state.me, Math.max(map.getZoom(), 15));
    else toast('Venter på din position – tillad placering for Safari');
    askCompass();
  });
  $('btnLayer').addEventListener('click', () => {
    map.removeLayer(layers[layerName]);
    layerName = layerName === 'kort' ? 'foto' : 'kort';
    layers[layerName].addTo(map);
    store.setPrefs({ layer: layerName });
  });
  $('btnNight').addEventListener('click', () => {
    const on = !document.body.classList.contains('night');
    applyNight(on);
    store.setPrefs({ night: on });
  });
}

function openSpot(id) {
  state.view.spot = id;
  switchTab('steder');
  if ($('sheet').dataset.state === 'peek') setSheet('mid');
  renderPanel();
  const spot = state.spots.find((s) => s.id === id);
  focus(spot.center);
}

function switchTab(tab) {
  if (state.view.tab === tab && $('sheet').dataset.state === 'peek') setSheet('mid');
  state.view.tab = tab;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
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
  if (typeof map !== 'undefined') map.invalidateSize();
  if ($('sheet').dataset.state) setSheet($('sheet').dataset.state);
  if ($('screenInfo')) $('screenInfo').textContent = screenInfo();
}
function screenInfo() {
  const sa = (side) => { const el = document.createElement('div'); el.style.cssText = `position:fixed;visibility:hidden;height:env(safe-area-inset-${side})`; document.body.append(el); const h = el.offsetHeight; el.remove(); return h; };
  return `App v${APP_VERSION} · Skærm ${screen.width}×${screen.height} · vindue ${window.innerHeight} · dokument ${document.documentElement.clientHeight} · top ${sa('top')} · bund ${sa('bottom')} · rettelse: ${lastFix} · ${isStandalone() ? 'hjemmeskærm' : 'browser'}`;
}
fixViewport();
for (const ev of ['resize', 'orientationchange', 'pageshow']) window.addEventListener(ev, () => setTimeout(fixViewport, 100));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(fixViewport, 150); });
document.addEventListener('focusout', (e) => { if (e.target.matches('input, textarea')) setTimeout(fixViewport, 300); });

/* Bundarket: sammenfoldet (tidslinje + knap), halvt eller næsten helt op. Træk eller tryk. */
function sheetHeights() {
  const sheet = $('sheet');
  const safe = parseFloat(getComputedStyle(sheet).paddingBottom) || 0;
  const tl = sheet.classList.contains('trip') ? 0 : $('timeline').offsetHeight + $('scopes').offsetHeight;
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
      setSheet(order[(order.indexOf(sheet.dataset.state) + 1) % 3]);
      return;
    }
    const cur = sheet.offsetHeight;
    const best = Object.entries(h).reduce((a, b) => (Math.abs(b[1] - cur) < Math.abs(a[1] - cur) ? b : a))[0];
    setSheet(best);
  };
  grab.addEventListener('pointerup', end);
  grab.addEventListener('pointercancel', end);
  window.addEventListener('resize', () => setSheet(sheet.dataset.state));
}

// Centrér et punkt i den synlige del af kortet (mellem toplinjen og bundarket)
function focus(latlng, zoom) {
  const top = ($('hud').hidden ? $('top') : $('hud')).getBoundingClientRect().bottom;
  const sheetH = $('sheet').offsetHeight;
  map.setView(latlng, zoom ?? map.getZoom(), { animate: false });
  map.panBy([0, Math.round((sheetH - top) / 2)], { animate: false });
}

function applyNight(on) {
  document.body.classList.toggle('night', on);
  $('btnNight').setAttribute('aria-pressed', String(on));
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
  if (action) el.querySelector('button').onclick = () => { action(); el.hidden = true; };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, actionLabel ? 5000 : 3000);
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

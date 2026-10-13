// Synkronisering af ture til Airtable: én række pr. tur i tabellen "Ture" i basen "Ravjagt".
// Nøglen (et personligt Airtable-token med adgang til netop den base) indtastes på telefonen
// og gemmes kun dér. Ændringer lægges i en udbakke og sendes, når der er net.
// Fund, UV-lygte og note kan rettes i Airtable og hentes tilbage til appen.

import * as store from './store.js';

const API = 'https://api.airtable.com/v0';
const TABLE = 'Ture';
const SCHEMA = 2; // hæves, når kolonnerne ændres, så telefonen opdaterer tabellen ved næste synk
const CONF = 'ravjagt.airtable.v1';
const RECS = 'ravjagt.records.v1'; // tur-id → Airtable-række-id

const read = (k, f) => { try { return JSON.parse(localStorage.getItem(k)) ?? f; } catch { return f; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

export const config = () => read(CONF, null);
export const isSetUp = () => !!(config()?.token && config()?.baseId);
export function forget() { localStorage.removeItem(CONF); localStorage.removeItem(RECS); }

const recs = () => read(RECS, {});
const setRec = (id, rec) => { const m = recs(); if (rec) m[id] = rec; else delete m[id]; write(RECS, m); };

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function at(path, { method = 'GET', body, token = config()?.token } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (res.status === 429) { await pause(31000); return at(path, { method, body, token }); } // Airtables loft: 5 kald/sek
  return res;
}

/* ---------- Tabellen ---------- */
const DT = { dateFormat: { name: 'european' }, timeFormat: { name: '24hour' }, timeZone: 'Europe/Copenhagen' };
const NUM = (precision) => ({ type: 'number', options: { precision } });
const FIELDS = [
  { name: 'Tur', type: 'singleLineText', description: 'Dag, tidspunkt og sted – sat af appen' },
  { name: 'Start', type: 'dateTime', options: DT, description: 'Hvornår du trykkede “Start tur her”' },
  { name: 'Minutter', ...NUM(0), description: 'Turens længde' },
  { name: 'Fund', ...NUM(0), description: 'Antal stykker rav. Kan rettes her – appen henter rettelsen' },
  { name: 'UV-lygte', type: 'checkbox', options: { icon: 'check', color: 'greenBright' }, description: 'Brugte du UV-lygte? Kan rettes her' },
  { name: 'Note', type: 'multilineText', description: 'Din note. Kan rettes her' },
  { name: 'Sted', type: 'singleLineText', description: 'Nærmeste kyststrækning ved start' },
  { name: 'Farve', type: 'singleSelect', options: { choices: [{ name: 'Grøn', color: 'greenBright' }, { name: 'Gul', color: 'yellowBright' }, { name: 'Rød', color: 'redBright' }] }, description: 'Hvad appen sagde ved start. Sammenlign med Fund for at se, om modellen rammer' },
  { name: 'Score', ...NUM(0), description: 'Modellens score 0–100 ved start (grøn ≥ 55, gul ≥ 30)' },
  { name: 'Vind (m/s)', ...NUM(1), description: 'Middelvind ved start (Open-Meteo)' },
  { name: 'Vindretning (°)', ...NUM(0), description: 'Hvor vinden kom fra. 270 = vest' },
  { name: 'Bølger (m)', ...NUM(1), description: 'Bølgehøjde ud for kysten ved start' },
  { name: 'Vandstand (cm)', ...NUM(0), description: 'Modelleret vandstand. Negativ = lavvande' },
  { name: 'Mørkt', type: 'checkbox', options: { icon: 'check', color: 'grayBright' }, description: 'Var det mørkt ved start?' },
  { name: 'Gået (m)', ...NUM(0), description: 'Hvor langt du gik ifølge GPS' },
  { name: 'Slut', type: 'dateTime', options: DT, description: 'Hvornår du afsluttede turen' },
  { name: 'Startpunkt', type: 'singleLineText', description: 'Breddegrad, længdegrad hvor du startede' },
  { name: 'Modelversion', type: 'singleLineText', description: 'Hvilken version af modellen der gav farven' },
  { name: 'Tur-id', type: 'singleLineText', description: 'Appens id – rør ikke' },
  { name: 'Data', type: 'multilineText', description: 'Hele turen inkl. GPS-spor og fund-positioner som JSON – rør ikke' },
];

async function ensureTable(baseId, token) {
  const res = await at(`/meta/bases/${baseId}/tables`, { token });
  if (!res.ok) throw new Error(res.status === 403 ? 'Nøglen har ikke adgang til basens tabeller.' : `Airtable svarede ${res.status}.`);
  const { tables } = await res.json();
  const table = tables.find((t) => t.name === TABLE);
  if (!table) {
    const c = await at(`/meta/bases/${baseId}/tables`, { method: 'POST', token, body: { name: TABLE, description: 'Ture fra Ravjagt-appen', fields: FIELDS } });
    if (!c.ok) {
      const err = await c.json().catch(() => ({}));
      throw new Error(c.status === 403 ? 'Giv nøglen rettigheden "schema.bases:write".' : `Airtable: ${err?.error?.message || c.status}`);
    }
    return;
  }
  // Eksisterende tabel: tilføj manglende kolonner og hold forklaringerne opdaterede
  const have = new Map(table.fields.map((f) => [f.name, f]));
  for (const f of FIELDS) {
    const cur = have.get(f.name);
    if (!cur) await at(`/meta/bases/${baseId}/tables/${table.id}/fields`, { method: 'POST', token, body: f });
    else if ((cur.description || '') !== f.description) await at(`/meta/bases/${baseId}/tables/${table.id}/fields/${cur.id}`, { method: 'PATCH', token, body: { description: f.description } });
    else continue;
    await pause(250);
  }
}

// Finder basen "Ravjagt", opretter tabellen og gemmer nøglen
export async function setUp(rawToken) {
  const token = rawToken.trim();
  let res;
  try { res = await at('/meta/bases', { token }); } catch { return { ok: false, msg: 'Ingen forbindelse. Prøv igen, når du har net.' }; }
  if (res.status === 401) return { ok: false, msg: 'Nøglen virker ikke. Tjek, at du har kopieret hele nøglen.' };
  if (res.status === 403) return { ok: false, msg: 'Nøglen mangler rettigheden "schema.bases:read".' };
  if (!res.ok) return { ok: false, msg: `Airtable svarede ${res.status}. Prøv igen.` };
  const { bases } = await res.json();
  const base = bases.find((b) => /ravjagt/i.test(b.name)) || (bases.length === 1 ? bases[0] : null);
  if (!base) {
    return { ok: false, msg: bases.length ? 'Nøglen har ikke adgang til en base, der hedder "Ravjagt". Tilføj den under "Access".' : 'Nøglen har ikke adgang til nogen base. Tilføj basen "Ravjagt" under "Access".' };
  }
  try { await ensureTable(base.id, token); } catch (e) {
    return { ok: false, msg: `Kunne ikke oprette tabellen "Ture". ${e.message}` };
  }
  write(CONF, { token, baseId: base.id, baseName: base.name, schema: SCHEMA });
  return { ok: true, baseName: base.name };
}

/* ---------- Synk ---------- */
let running = null;
export function sync() {
  if (!isSetUp()) return Promise.resolve({ ok: false, reason: 'not-set-up' });
  if (!running) running = doSync().finally(() => { running = null; });
  return running;
}

async function doSync() {
  try {
    // Ture fra før synkroniseringen kom på, sendes op første gang
    const known = recs();
    const queued = new Set(store.outbox().map((x) => x.id));
    for (const t of store.trips()) if (!known[t.id] && !queued.has(t.id)) store.setOutbox([...store.outbox(), { op: 'put', id: t.id }]);

    if (config().schema !== SCHEMA) {
      await ensureTable(config().baseId, config().token);
      write(CONF, { ...config(), schema: SCHEMA });
    }
    await flushOutbox();
    const pulled = await pull();
    write(CONF, { ...config(), lastSync: Date.now(), remoteCount: pulled.remoteCount });
    return { ok: true, ...pulled };
  } catch (err) {
    return { ok: false, reason: 'error', msg: friendly(err) };
  }
}

const friendly = (err) => {
  const m = String(err?.message || err);
  if (/Failed to fetch|NetworkError|Load failed|offline/i.test(m)) return 'ingen forbindelse';
  if (/401/.test(m)) return 'nøglen virker ikke længere – forbind igen';
  if (/403|404/.test(m)) return 'nøglen har ikke adgang til basen – forbind igen';
  return m;
};

async function flushOutbox() {
  for (const item of [...store.outbox()]) {
    if (item.op === 'put') await pushTrip(item.id);
    else await removeTrip(item.id);
    store.setOutbox(store.outbox().filter((x) => !(x.id === item.id && x.op === item.op)));
    await pause(220);
  }
}

const base = () => `/${config().baseId}/${encodeURIComponent(TABLE)}`;
const LEVEL = { green: 'Grøn', yellow: 'Gul', red: 'Rød' };
const DAYS = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør'];

function toFields(t) {
  const d = new Date(t.startedAt);
  const m = t.model || {};
  const wx = m.wx || {};
  // Airtable tillader 100.000 tegn i et felt: tynd sporet ud, hvis turen er meget lang
  let trip = t;
  let json = JSON.stringify(trip);
  for (let step = 2; json.length > 95000 && step < 64; step *= 2) {
    trip = { ...t, track: t.track.filter((_, i) => i % step === 0 || i === t.track.length - 1) };
    json = JSON.stringify(trip);
  }
  return {
    Tur: `${DAYS[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1} kl. ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}${m.spotName ? ` · ${m.spotName}` : ''}`,
    Start: t.startedAt,
    Slut: t.endedAt || null,
    Minutter: t.durationMin ?? null,
    Fund: t.finds ?? 0,
    'UV-lygte': !!t.uv,
    Note: t.note || '',
    Sted: m.spotName || '',
    Farve: LEVEL[m.level] || null,
    Score: m.score ?? null,
    'Vind (m/s)': wx.ws ?? null,
    'Vindretning (°)': wx.wd ?? null,
    'Bølger (m)': wx.wave ?? null,
    'Vandstand (cm)': wx.sl != null ? Math.round(wx.sl * 100) : null,
    Mørkt: wx.isDay === 0,
    'Gået (m)': t.walkedM ?? null,
    Startpunkt: t.start ? `${t.start[0]}, ${t.start[1]}` : '',
    Modelversion: m.version || '',
    'Tur-id': t.id,
    Data: json,
  };
}

function fromRecord(r) {
  const f = r.fields || {};
  let t;
  try { t = JSON.parse(f.Data); } catch { return null; }
  if (!t?.id) return null;
  // Det, man kan rette i Airtable, vinder over appens kopi
  if (typeof f.Fund === 'number') t.finds = f.Fund;
  t.uv = !!f['UV-lygte'];
  t.note = f.Note || '';
  return t;
}

async function pushTrip(id) {
  const trip = store.trips().find((t) => t.id === id);
  if (!trip) return;
  const fields = toFields(trip);
  const rec = recs()[id];
  let res = rec
    ? await at(`${base()}/${rec}`, { method: 'PATCH', body: { fields, typecast: true } })
    : await at(base(), { method: 'POST', body: { records: [{ fields }], typecast: true } });
  if (rec && res.status === 404) {
    // Rækken er slettet i Airtable i mellemtiden: opret den igen
    res = await at(base(), { method: 'POST', body: { records: [{ fields }], typecast: true } });
  }
  if (!res.ok) throw new Error(`Kunne ikke gemme tur (${res.status})`);
  const body = await res.json();
  setRec(id, body.records ? body.records[0].id : body.id);
}

async function removeTrip(id) {
  const rec = recs()[id];
  if (!rec) return;
  const res = await at(`${base()}/${rec}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`Kunne ikke slette tur (${res.status})`);
  setRec(id, null);
}

async function pull() {
  const remote = new Map();
  let offset;
  do {
    const q = new URLSearchParams({ pageSize: '100' });
    if (offset) q.set('offset', offset);
    const res = await at(`${base()}?${q}`);
    if (!res.ok) throw new Error(`Kunne ikke hente ture (${res.status})`);
    const body = await res.json();
    for (const r of body.records) {
      const t = fromRecord(r);
      if (t) remote.set(t.id, { rec: r.id, trip: t });
    }
    offset = body.offset;
  } while (offset);

  const local = new Map(store.trips().map((t) => [t.id, t]));
  const pending = new Set(store.outbox().map((x) => x.id));
  let added = 0, removed = 0;
  for (const [id, { rec, trip }] of remote) {
    if (pending.has(id)) continue;
    if (!local.has(id)) added++;
    store.syncLocal.put(trip);
    setRec(id, rec);
  }
  // Slettet i Airtable eller på en anden enhed: tidligere synket, nu væk
  for (const id of local.keys()) {
    if (!remote.has(id) && recs()[id] && !pending.has(id)) { store.syncLocal.remove(id); setRec(id, null); removed++; }
  }
  return { added, removed, remoteCount: remote.size };
}

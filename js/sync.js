// Synkronisering af ture til et privat GitHub-repo: én fil pr. tur i trips/<id>.json.
// Nøglen (et fine-grained token med adgang til netop det repo) indtastes på telefonen
// og gemmes kun dér. Ændringer lægges i en udbakke og sendes, når der er net.

import * as store from './store.js';

export const REPO = 'kennethabrahamsson/ravjagt-data';
const API = `https://api.github.com/repos/${REPO}`;
const CONF = 'ravjagt.sync.v1';
const SHAS = 'ravjagt.shas.v1'; // id → sha for ture, der ligger i skyen

const read = (k, f) => { try { return JSON.parse(localStorage.getItem(k)) ?? f; } catch { return f; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

export const config = () => read(CONF, null);
export const isSetUp = () => !!config()?.token;
export function forget() { localStorage.removeItem(CONF); localStorage.removeItem(SHAS); }

const shas = () => read(SHAS, {});
const setSha = (id, sha) => { const m = shas(); if (sha) m[id] = sha; else delete m[id]; write(SHAS, m); };

async function gh(path, { method = 'GET', body, raw = false } = {}) {
  const token = config()?.token;
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  return res;
}

const b64 = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

// Tjekker nøglen, før den gemmes
export async function setUp(token) {
  write(CONF, { token: token.trim() });
  let res;
  try { res = await gh(''); } catch { forget(); return { ok: false, msg: 'Ingen forbindelse. Prøv igen, når du har net.' }; }
  if (res.status === 200) {
    const repo = await res.json();
    if (!repo.permissions?.push) { forget(); return { ok: false, msg: 'Nøglen kan læse, men ikke skrive. Giv den "Contents: Read and write".' }; }
    return { ok: true };
  }
  forget();
  if (res.status === 401) return { ok: false, msg: 'Nøglen virker ikke. Tjek, at du har kopieret hele nøglen.' };
  if (res.status === 404) return { ok: false, msg: 'Nøglen har ikke adgang til ravjagt-data. Vælg repoet under "Repository access".' };
  return { ok: false, msg: `GitHub svarede ${res.status}. Prøv igen.` };
}

let running = null;
export function sync() {
  if (!isSetUp()) return Promise.resolve({ ok: false, reason: 'not-set-up' });
  if (!running) running = doSync().finally(() => { running = null; });
  return running;
}

async function doSync() {
  try {
    // Ture fra før synkroniseringen kom på, sendes op første gang
    const known = shas();
    const queued = new Set(store.outbox().map((x) => x.id));
    for (const t of store.trips()) if (!known[t.id] && !queued.has(t.id)) store.setOutbox([...store.outbox(), { op: 'put', id: t.id }]);

    await flushOutbox();
    const pulled = await pull();
    const now = Date.now();
    write(CONF, { ...config(), lastSync: now, remoteCount: pulled.remoteCount });
    return { ok: true, ...pulled };
  } catch (err) {
    write(CONF, { ...config(), lastError: String(err.message || err), lastErrorAt: Date.now() });
    return { ok: false, reason: 'error', msg: String(err.message || err) };
  }
}

async function flushOutbox() {
  for (const item of [...store.outbox()]) {
    if (item.op === 'put') await pushTrip(item.id);
    else await removeTrip(item.id);
    store.setOutbox(store.outbox().filter((x) => !(x.id === item.id && x.op === item.op)));
  }
}

async function pushTrip(id) {
  const trip = store.trips().find((t) => t.id === id);
  if (!trip) return;
  const path = `/contents/trips/${id}.json`;
  const body = (sha) => ({ message: `Tur ${trip.startedAt.slice(0, 16).replace('T', ' ')} · ${trip.finds} fund`, content: b64(JSON.stringify(trip, null, 1)), ...(sha ? { sha } : {}) });
  let res = await gh(path, { method: 'PUT', body: body(shas()[id]) });
  if (res.status === 409 || res.status === 422) {
    // Filen findes allerede med en anden version: hent den aktuelle og prøv igen
    const cur = await gh(path);
    const sha = cur.ok ? (await cur.json()).sha : undefined;
    res = await gh(path, { method: 'PUT', body: body(sha) });
  }
  if (!res.ok) throw new Error(`Kunne ikke gemme tur (${res.status})`);
  setSha(id, (await res.json()).content.sha);
}

async function removeTrip(id) {
  const path = `/contents/trips/${id}.json`;
  let sha = shas()[id];
  if (!sha) {
    const cur = await gh(path);
    if (cur.status === 404) return;
    sha = (await cur.json()).sha;
  }
  const res = await gh(path, { method: 'DELETE', body: { message: `Slet tur ${id}`, sha } });
  if (!res.ok && res.status !== 404) throw new Error(`Kunne ikke slette tur (${res.status})`);
  setSha(id, null);
}

async function pull() {
  const res = await gh('/contents/trips');
  const list = res.status === 404 ? [] : res.ok ? await res.json() : null;
  if (!list) throw new Error(`Kunne ikke hente ture (${res.status})`);
  const remote = new Map(list.filter((f) => f.name.endsWith('.json')).map((f) => [f.name.slice(0, -5), f.sha]));
  const local = new Map(store.trips().map((t) => [t.id, t]));
  const pending = new Set(store.outbox().map((x) => x.id));
  let added = 0, removed = 0;

  for (const [id, sha] of remote) {
    if (pending.has(id)) continue;
    if (local.has(id) && shas()[id] === sha) continue;
    const r = await gh(`/contents/trips/${id}.json`, { raw: true });
    if (!r.ok) continue;
    store.syncLocal.put(await r.json());
    setSha(id, sha);
    if (!local.has(id)) added++;
  }
  // Slettet på en anden enhed: tidligere synket, nu væk fra skyen
  for (const id of local.keys()) {
    if (!remote.has(id) && shas()[id] && !pending.has(id)) { store.syncLocal.remove(id); setSha(id, null); removed++; }
  }
  return { added, removed, remoteCount: remote.size };
}

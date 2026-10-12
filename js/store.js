// Ture gemmes på telefonen. Den igangværende tur gemmes løbende, så intet går tabt,
// hvis telefonen lukker appen.

const TRIPS = 'ravjagt.trips.v1';
const ACTIVE = 'ravjagt.active.v1';
const PREFS = 'ravjagt.prefs.v1';

const read = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

const OUTBOX = 'ravjagt.outbox.v1'; // ændringer, der venter på at blive sendt til skyen

export const trips = () => read(TRIPS, []);
const putLocal = (t) => {
  const all = trips().filter((x) => x.id !== t.id);
  all.push(t);
  all.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return write(TRIPS, all);
};
const removeLocal = (id) => write(TRIPS, trips().filter((x) => x.id !== id));

export const saveTrip = (t) => { enqueue({ op: 'put', id: t.id }); return putLocal(t); };
export const deleteTrip = (id) => { enqueue({ op: 'del', id }); return removeLocal(id); };

// Til synkroniseringen: ændrer kun telefonen, sender intet
export const syncLocal = { put: putLocal, remove: removeLocal };

export const outbox = () => read(OUTBOX, []);
export const setOutbox = (o) => write(OUTBOX, o);
function enqueue(item) {
  const o = outbox().filter((x) => x.id !== item.id);
  o.push(item);
  setOutbox(o);
}

export const activeTrip = () => read(ACTIVE, null);
export const setActiveTrip = (t) => (t ? write(ACTIVE, t) : localStorage.removeItem(ACTIVE));

export const prefs = () => read(PREFS, { night: false, layer: 'kort' });
export const setPrefs = (p) => write(PREFS, { ...prefs(), ...p });

export async function askPersist() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch {}
  return false;
}

export function exportAll() {
  return JSON.stringify({ app: 'ravjagt', exportedAt: new Date().toISOString(), trips: trips() }, null, 2);
}

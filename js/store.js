// Ture gemmes på telefonen. Den igangværende tur gemmes løbende, så intet går tabt,
// hvis telefonen lukker appen.

const TRIPS = 'ravjagt.trips.v1';
const ACTIVE = 'ravjagt.active.v1';
const PREFS = 'ravjagt.prefs.v1';

const read = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };

export const trips = () => read(TRIPS, []);
export const saveTrip = (t) => { const all = trips().filter((x) => x.id !== t.id); all.unshift(t); return write(TRIPS, all); };
export const deleteTrip = (id) => write(TRIPS, trips().filter((x) => x.id !== id));

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

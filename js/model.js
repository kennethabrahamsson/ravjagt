// Ravmodellen v0.3 – en hypotese, der skal kalibreres med egne ture.
// Spørgsmålet er: skal jeg gå ud nu med UV-lygten?
// Rav skyller op efter vedvarende pålandsvind over åbent hav, ligger friskest lige efter,
// at vinden har lagt sig, er nemmest at nå ved lavvande og kan kun ses med UV i mørke.
// Høfder og moler holder på drivmaterialet på den side, strømmen langs kysten kommer fra.

export const MODEL_VERSION = '0.3';

const RAD = Math.PI / 180;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));

export const angDiff = (a, b) => ((a - b + 540) % 360) - 180;
export const onshore = (ws, wd, normal) => ws * Math.cos(angDiff(wd, normal) * RAD);
// Positiv = strømmen langs kysten løber mod retningen normal − 90°
export const along = (ws, wd, normal) => ws * Math.sin(angDiff(wd, normal) * RAD);

export const LEVELS = {
  green: { label: 'Gå ud', min: 55 },
  yellow: { label: 'Måske', min: 30 },
  red: { label: 'Spild af tid', min: 0 },
};
export const levelOf = (score) => (score >= 55 ? 'green' : score >= 30 ? 'yellow' : 'red');

const decay = (age) => Math.exp(-Math.max(0, age - 12) / 36);

// Bølger kræver åbent vand: 3 km giver intet, 150 km eller mere giver fuld effekt
const fetchFactor = (km) => clamp(Math.log(Math.max(km, 1) / 3) / Math.log(150 / 3));
function exposure(spot, wd) {
  if (!spot.fetch) return 1;
  const x = ((wd % 360) + 360) % 360 / 22.5;
  const a = Math.floor(x) % 16, b = (a + 1) % 16, f = x - Math.floor(x);
  return fetchFactor(spot.fetch[a] * (1 - f) + spot.fetch[b] * f);
}

const WORDS = ['nord', 'nordøst', 'øst', 'sydøst', 'syd', 'sydvest', 'vest', 'nordvest'];
const sideWord = (deg) => WORDS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

// Forberedte serier pr. strækning (genbruges, til vejret skifter)
function prep(w, spot) {
  if (spot._w === w) return spot._p;
  const n = w.time.length;
  const on = new Float32Array(n), eff = new Float32Array(n), alongS = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    on[j] = onshore(w.ws[j], w.wd[j], spot.normal);
    eff[j] = on[j] * exposure(spot, w.wd[j]);
    alongS[j] = along(w.ws[j], w.wd[j], spot.normal);
  }
  const pre = new Float64Array(n + 1), preA = new Float64Array(n + 1);
  for (let j = 0; j < n; j++) { pre[j + 1] = pre[j] + eff[j]; preA[j + 1] = preA[j] + alongS[j]; }
  const sus = new Float32Array(n);
  for (let j = 0; j < n; j++) { const a = Math.max(0, j - 11); sus[j] = (pre[j + 1] - pre[a]) / (j + 1 - a); }
  spot._w = w;
  spot._p = { on, eff, sus, preA, hasWave: w.wave.some((v) => v != null) };
  return spot._p;
}

/** Score for strækning `spot` på time i. w: vejrserien for strækningens vejrpunkt. */
export function scoreAt(w, i, spot, brief = false) {
  const p = prep(w, spot);
  let peak = 0, rawPeak = 0, rawPeakAge = null, maxWave = 0, rawWave = 0;
  for (let j = Math.max(0, i - 72); j <= i; j++) {
    const age = i - j;
    const e = p.sus[j] * decay(age);
    if (e > peak) peak = e;
    if (p.eff[j] > rawPeak) { rawPeak = p.eff[j]; rawPeakAge = age; }
    const wh = w.wave[j];
    if (wh != null && age <= 48) { maxWave = Math.max(maxWave, wh * decay(age)); rawWave = Math.max(rawWave, wh); }
  }
  const drift = p.preA[i + 1] - p.preA[Math.max(0, i - 23)];

  const wind = clamp((peak - 5) / 7);
  const storm = p.hasWave ? 0.6 * wind + 0.4 * clamp((maxWave - 1) / 1.5) : wind;

  const onNow = p.on[i];
  let timing = 1, phase = 'efter';
  if (onNow > 7 || (w.ws[i] > 9.5 && onNow > 2)) { timing = 0.5; phase = 'under'; }
  else if (onNow < -6) { timing = 0.85; phase = 'fraland'; }

  const sl = w.sl[i];
  const tide = sl == null ? 0 : clamp((0.2 - sl) / 0.7) * 0.12;

  let trapF = 1, trapNote = null;
  if (spot.traps) {
    const what = spot.traps === 1 ? 'En høfde eller mole' : `${spot.traps} høfder/moler`;
    if (Math.abs(drift) > 20) {
      trapF = 1.25;
      const side = sideWord(drift > 0 ? spot.normal + 90 : spot.normal - 90);
      trapNote = `${what} her – led på ${side}siden, hvor strømmen samler materialet`;
    } else { trapF = 1.1; trapNote = `${what} her holder på drivmaterialet`; }
  }

  let score = Math.round(100 * clamp(storm * timing * trapF + tide * (storm > 0.15 ? 1 : 0.3)));
  const dark = w.isDay?.[i] === 0;
  if (!dark) score = Math.min(54, Math.round(score * 0.65));
  if (brief) return score;

  const reasons = [];
  if (rawPeak >= 5) {
    reasons.push(rawPeakAge === 0 ? `Pålandsvind ${fmt(rawPeak)} m/s lige nu` : `Pålandsvind op til ${fmt(rawPeak)} m/s for ${ageText(rawPeakAge)} siden`);
  } else reasons.push('Ingen kraftig pålandsvind de sidste 3 døgn');
  if (rawWave >= 1) reasons.push(`Bølger op til ${fmt(rawWave)} m`);
  if (phase === 'under') reasons.push('Stormen står stadig på – rav ruller i brændingen');
  if (phase === 'fraland') reasons.push('Fralandsvind nu – intet nyt kommer ind');
  if (phase === 'efter' && rawPeak >= 8 && rawPeakAge > 0 && rawPeakAge <= 30) reasons.push('Vinden har lagt sig – godt tidspunkt');
  if (sl != null) reasons.push(sl < -0.2 ? 'Lavvande – stor strand fri' : sl > 0.3 ? 'Højvande – lidt strand' : 'Middel vandstand');
  if (trapNote) reasons.push(trapNote);
  reasons.push(dark ? 'Mørkt – UV-lygten virker' : 'Lyst – UV-lygten virker ikke, led med øjnene');

  return {
    score, level: levelOf(score), reasons,
    f: { storm: +storm.toFixed(3), timing, trapF, tide: +tide.toFixed(3), peak: +rawPeak.toFixed(1), peakAge: rawPeakAge, wave: +rawWave.toFixed(2), drift: Math.round(drift), onNow: +onNow.toFixed(1), sl },
  };
}

const fmt = (x) => x.toFixed(x < 10 ? 1 : 0).replace('.', ',');
const ageText = (h) => (h < 36 ? `${h} t` : `${Math.round(h / 24)} døgn`);

export function lowTides(w) {
  const out = [];
  for (let i = 1; i < w.sl.length - 1; i++) {
    const a = w.sl[i - 1], b = w.sl[i], c = w.sl[i + 1];
    if (a == null || b == null || c == null) continue;
    if (b < a && b <= c) out.push(i);
  }
  return out;
}

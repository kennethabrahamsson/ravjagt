// Ravmodellen v0.1 – en hypotese, der skal kalibreres med egne fund.
// Idé: rav skyller op efter kraftig pålandsvind og høje bølger, ligger
// friskest lige efter, at vinden har lagt sig, og er nemmest at nå ved lavvande.
// Strøm langs kysten skubber drivmateriale op mod den ene side af moler.

export const MODEL_VERSION = '0.1';

const RAD = Math.PI / 180;
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));

// a - b i intervallet [-180, 180)
export const angDiff = (a, b) => ((a - b + 540) % 360) - 180;

// Vindkomponent ind mod land. normal = retningen havet ligger i (vinden kommer fra).
export const onshore = (ws, wd, normal) => ws * Math.cos(angDiff(wd, normal) * RAD);

// Positiv = vinden skubber vandet mod syd langs en vestvendt kyst.
export const alongSouth = (ws, wd, normal) => ws * Math.sin(angDiff(wd, normal) * RAD);

export const LEVELS = {
  green: { label: 'God chance', min: 55 },
  yellow: { label: 'Måske', min: 30 },
  red: { label: 'Spild af tid', min: 0 },
};
export const levelOf = (score) => (score >= 55 ? 'green' : score >= 30 ? 'yellow' : 'red');

const decay = (age) => Math.exp(-Math.max(0, age - 12) / 36);

/**
 * Score for et sted på time i.
 * w: { time[], ws[], wd[], gust[], wave[], sl[], isDay[] }
 * spot: { normal, trap?: { side: 'north'|'south'|'both' } }
 */
export function scoreAt(w, i, spot) {
  // Rav skal have tid til at drive ind: vi bruger pålandsvinden i snit over 12 timer,
  // ikke et enkelt vindstød. En storm, der lige er begyndt, tæller derfor endnu ikke fuldt.
  let peak = 0, rawPeak = 0, rawPeakAge = null, maxWave = 0, rawWave = 0, drift = 0;
  for (let j = Math.max(0, i - 72); j <= i; j++) {
    const age = i - j;
    const on = onshore(w.ws[j], w.wd[j], spot.normal);
    let sum = 0, cnt = 0;
    for (let m = Math.max(0, j - 11); m <= j; m++) { sum += onshore(w.ws[m], w.wd[m], spot.normal); cnt++; }
    const sustained = sum / cnt;
    const eff = sustained * decay(age);
    if (eff > peak) peak = eff;
    if (on > rawPeak) { rawPeak = on; rawPeakAge = age; }
    const wh = w.wave[j];
    if (wh != null && age <= 48) {
      maxWave = Math.max(maxWave, wh * decay(age));
      rawWave = Math.max(rawWave, wh);
    }
    if (age <= 24) drift += alongSouth(w.ws[j], w.wd[j], spot.normal);
  }

  const storm = 0.6 * clamp((peak - 5) / 7) + 0.4 * clamp((maxWave - 1) / 1.5);

  const onNow = onshore(w.ws[i], w.wd[i], spot.normal);
  let timing = 1;
  let phase = 'efter';
  if (onNow > 9 && onNow > 0.85 * rawPeak) { timing = 0.7; phase = 'under'; }
  else if (onNow < -6) { timing = 0.85; phase = 'fraland'; }

  const sl = w.sl[i];
  const tide = sl == null ? 0 : clamp((0.2 - sl) / 0.7) * 0.12;

  let trapF = 1;
  let trapNote = null;
  if (spot.trap) {
    const side = spot.trap.side;
    const south = drift > 20, north = drift < -20;
    if (side === 'both') { trapF = 1.15; trapNote = 'Bølgebryderne holder på drivmaterialet'; }
    else if ((side === 'north' && south) || (side === 'south' && north)) {
      trapF = 1.3;
      trapNote = south ? 'Strømmen løber mod syd – materialet samles her' : 'Strømmen løber mod nord – materialet samles her';
    } else if (side === 'north' || side === 'south') {
      trapNote = 'Strømmen løber den forkerte vej for netop denne side';
    }
  }

  const score = Math.round(100 * clamp(storm * timing * trapF + tide * (storm > 0.15 ? 1 : 0.3)));

  const reasons = [];
  if (rawPeak >= 6) {
    reasons.push(rawPeakAge === 0
      ? `Pålandsvind ${fmt(rawPeak)} m/s lige nu`
      : `Pålandsvind op til ${fmt(rawPeak)} m/s for ${ageText(rawPeakAge)} siden`);
  } else reasons.push('Ingen kraftig pålandsvind de sidste 3 døgn');
  if (rawWave >= 1) reasons.push(`Bølger op til ${fmt(rawWave)} m`);
  if (phase === 'under') reasons.push('Stormen står stadig på – rav ruller i brændingen');
  if (phase === 'fraland') reasons.push('Fralandsvind nu – intet nyt kommer ind');
  if (phase === 'efter' && rawPeak >= 8 && rawPeakAge > 0 && rawPeakAge <= 30) reasons.push('Vinden har lagt sig – godt tidspunkt');
  if (sl != null) reasons.push(sl < -0.2 ? 'Lavvande – stor strand fri' : sl > 0.3 ? 'Højvande – lidt strand' : 'Middel vandstand');
  if (trapNote) reasons.push(trapNote);

  return {
    score, level: levelOf(score), reasons,
    f: { storm: +storm.toFixed(3), timing, trapF, tide: +tide.toFixed(3), peak: +rawPeak.toFixed(1), peakAge: rawPeakAge, wave: +rawWave.toFixed(2), drift: Math.round(drift), onNow: +onNow.toFixed(1), sl },
  };
}

const fmt = (x) => x.toFixed(x < 10 ? 1 : 0).replace('.', ',');
const ageText = (h) => (h < 36 ? `${h} t` : `${Math.round(h / 24)} døgn`);

// Lavvande: lokale minima i vandstanden
export function lowTides(w) {
  const out = [];
  for (let i = 1; i < w.sl.length - 1; i++) {
    const a = w.sl[i - 1], b = w.sl[i], c = w.sl[i + 1];
    if (a == null || b == null || c == null) continue;
    if (b < a && b <= c) out.push(i);
  }
  return out;
}

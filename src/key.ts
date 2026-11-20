/* Song key: names, parsing from text, detection from audio (chroma + Krumhansl profiles), scale notes. */

export interface SongKey {
  tonic: number; // 0 = C … 11 = B
  mode: "major" | "minor";
}

const SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
// Keys conventionally spelled with flats.
const FLAT_MAJOR = new Set([5, 10, 3, 8, 1, 6]); // F Bb Eb Ab Db Gb
const FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3]); // Dm Gm Cm Fm Bbm Ebm

export function noteNames(k: SongKey): string[] {
  const flat = k.mode === "major" ? FLAT_MAJOR.has(k.tonic) : FLAT_MINOR.has(k.tonic);
  return flat ? FLAT : SHARP;
}

export function keyName(k: SongKey): string {
  return `${noteNames(k)[k.tonic]} ${k.mode}`;
}

export function keyShort(k: SongKey): string {
  return `${noteNames(k)[k.tonic]}${k.mode === "minor" ? "m" : ""}`;
}

/** Relative major/minor (same notes): A minor ↔ C major. */
export function relative(k: SongKey): SongKey {
  return k.mode === "minor" ? { tonic: (k.tonic + 3) % 12, mode: "major" } : { tonic: (k.tonic + 9) % 12, mode: "minor" };
}

export function scaleNotes(k: SongKey): string[] {
  const steps = k.mode === "major" ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
  const names = noteNames(k);
  return steps.map((s) => names[(k.tonic + s) % 12]);
}

const LETTER: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** Finds "Key: F# minor", "(Am)", "C#m", "Bb Major", "G min" in text. */
export function keyInText(text: string): SongKey | null {
  const t = text.replace(/♯/g, "#").replace(/♭/g, "b");
  const patterns = [
    /\bkey\s*(?:of|:|-)?\s*([A-Ga-g])\s*(#|b|sharp|flat)?\s*(maj(?:or)?|min(?:or)?|m)?\b/i,
    /\b([A-G])\s*(#|b|sharp|flat)?\s*(major|minor|maj|min)\b/i,
    /[\(\[|]\s*([A-G])(#|b)?(m|min|maj)?\s*[\)\]|]/,
    /\b([A-G])(#|b)?(m)\b(?=\s*(?:\||-|\)|\]|$|,|\s+\d{2,3}\s*bpm))/,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    let tonic = LETTER[m[1].toLowerCase()];
    const acc = (m[2] || "").toLowerCase();
    if (acc === "#" || acc === "sharp") tonic += 1;
    if (acc === "b" || acc === "flat") tonic -= 1;
    const q = (m[3] || "").toLowerCase();
    const mode = q.startsWith("min") || q === "m" ? "minor" : "major";
    return { tonic: (tonic + 12) % 12, mode };
  }
  return null;
}

/* ---------------- Detection from audio ---------------- */

// Krumhansl–Kessler key profiles.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function corr(a: number[], b: number[]): number {
  const ma = a.reduce((x, y) => x + y, 0) / 12;
  const mb = b.reduce((x, y) => x + y, 0) / 12;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < 12; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return num / Math.sqrt(da * db || 1);
}

/** Best key for a 12-bin pitch-class profile, with a confidence (correlation gap to the runner-up). */
export function keyFromChroma(chroma: number[]): { key: SongKey; confidence: number } | null {
  if (chroma.every((v) => v === 0)) return null;
  const scores: { key: SongKey; r: number }[] = [];
  for (let t = 0; t < 12; t++) {
    const rot = (p: number[]) => p.map((_, i) => p[(i - t + 12) % 12]);
    scores.push({ key: { tonic: t, mode: "major" }, r: corr(chroma, rot(MAJOR)) });
    scores.push({ key: { tonic: t, mode: "minor" }, r: corr(chroma, rot(MINOR)) });
  }
  scores.sort((a, b) => b.r - a.r);
  return { key: scores[0].key, confidence: scores[0].r - scores[1].r };
}

/**
 * Folds one FFT frame (dB values) into 12 pitch classes. Only clear spectral peaks between
 * 60 Hz and 1 kHz count (where bass and chords live), so overtones and noise matter less.
 * Each frame is normalised so loud moments don't drown out the rest.
 */
export function addChroma(chroma: number[], db: Float32Array, sampleRate: number, fftSize: number) {
  const binHz = sampleRate / fftSize;
  const lo = Math.max(2, Math.floor(60 / binHz));
  const hi = Math.min(db.length - 2, Math.ceil(1000 / binHz));
  let max = -Infinity;
  for (let i = lo; i <= hi; i++) if (db[i] > max) max = db[i];
  if (!isFinite(max) || max < -90) return;
  const frame = new Array(12).fill(0);
  for (let i = lo; i <= hi; i++) {
    const v = db[i];
    if (v < max - 30 || v <= db[i - 1] || v < db[i + 1]) continue; // peaks only, within 30 dB of the loudest
    // Interpolate the true peak frequency.
    const a = db[i - 1], b = v, c = db[i + 1];
    const p = 0.5 * (a - c) / (a - 2 * b + c || 1);
    const f = (i + p) * binHz;
    const midi = 69 + 12 * Math.log2(f / 440);
    const pc = ((Math.round(midi) % 12) + 12) % 12;
    const w = Math.pow(10, (v - max) / 20); // 0..1 relative loudness
    // Lower notes count a bit more: bass usually spells the root.
    frame[pc] += w * (f < 250 ? 1.5 : 1);
  }
  const sum = frame.reduce((x, y) => x + y, 0);
  if (sum > 0) for (let k = 0; k < 12; k++) chroma[k] += frame[k] / sum;
}

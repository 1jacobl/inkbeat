/* Click track locked to the video's playback position (song time), scheduled with Web Audio. */
import { estimateNow, isPlaying } from "./clock";

export interface Tempo {
  bpm: number;
  /** Song time (s) of a bar's first beat. Every other beat is counted from here. */
  downbeat: number;
  beatsPerBar: number;
}

let ctx: AudioContext | null = null;
let timer: number | null = null;
let tempo: Tempo | null = null;
let volume = 0.6;
let nudge = 0; // seconds; same sync nudge used for takes
let lastBeat = -Infinity; // index of the last scheduled beat
let lastSong = 0;
let onBeat: ((beatInBar: number) => void) | null = null;

const LOOKAHEAD = 0.12; // seconds of clicks scheduled ahead

function audio(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

function click(at: number, accent: boolean) {
  const ac = audio();
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = "square";
  o.frequency.value = accent ? 1760 : 1175;
  const peak = volume * (accent ? 0.5 : 0.32);
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(peak, at + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
  o.connect(g).connect(ac.destination);
  o.start(at);
  o.stop(at + 0.06);
}

function tick() {
  if (!tempo || tempo.bpm <= 0) return;
  const playing = isPlaying();
  const song = estimateNow() + nudge;
  if (!playing) {
    lastBeat = -Infinity;
    lastSong = song;
    return;
  }
  // A seek (jump either way) restarts the count from where we are.
  if (song < lastSong - 0.05 || song > lastSong + 0.5) lastBeat = -Infinity;
  lastSong = song;

  const ac = audio();
  const spb = 60 / tempo.bpm;
  const first = Math.ceil((song - tempo.downbeat) / spb - 1e-6);
  const last = Math.floor((song + LOOKAHEAD - tempo.downbeat) / spb);
  for (let i = Math.max(first, lastBeat + 1); i <= last; i++) {
    const beatTime = tempo.downbeat + i * spb;
    const at = ac.currentTime + Math.max(0, beatTime - song);
    const inBar = ((i % tempo.beatsPerBar) + tempo.beatsPerBar) % tempo.beatsPerBar;
    click(at, inBar === 0);
    if (onBeat) {
      const cb = onBeat;
      window.setTimeout(() => cb(inBar), Math.max(0, (beatTime - song) * 1000));
    }
    lastBeat = i;
  }
}

export const metronome = {
  /** Call from a click/tap so the browser lets audio start. */
  unlock() {
    audio();
  },
  start(t: Tempo) {
    tempo = t;
    lastBeat = -Infinity;
    audio();
    if (timer === null) timer = window.setInterval(tick, 25);
  },
  update(t: Tempo | null) {
    const changed = !tempo || !t || t.bpm !== tempo.bpm || t.downbeat !== tempo.downbeat;
    tempo = t;
    if (changed) lastBeat = -Infinity;
  },
  stop() {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    tempo = null;
  },
  setVolume(v: number) {
    volume = Math.max(0, Math.min(1, v));
  },
  setNudge(seconds: number) {
    nudge = seconds;
  },
  onBeat(cb: ((beatInBar: number) => void) | null) {
    onBeat = cb;
  },
};

/** Finds "90 BPM", "bpm: 140", "140bpm" in a video title. */
export function bpmFromTitle(title: string): number | null {
  const m = title.match(/(\d{2,3}(?:\.\d)?)\s*-?\s*bpm\b/i) || title.match(/\bbpm\s*[:\-]?\s*(\d{2,3}(?:\.\d)?)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return n >= 40 && n <= 220 ? n : null;
}

/** Tap tempo: average of the last few taps, ignoring a long pause. */
export function makeTapper() {
  let taps: number[] = [];
  return {
    tap(): { bpm: number | null; count: number; first: boolean } {
      const now = performance.now();
      const first = !taps.length || now - taps[taps.length - 1] > 2000;
      if (first) taps = [];
      taps.push(now);
      if (taps.length > 9) taps.shift();
      if (taps.length < 3) return { bpm: null, count: taps.length, first };
      const gaps = taps.slice(1).map((t, i) => t - taps[i]);
      const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      return { bpm: Math.round((60000 / avg) * 2) / 2, count: taps.length, first };
    },
  };
}

/** Plays `beats` clicks at `bpm` (first one accented) and resolves when the last beat is over. */
export function countIn(bpm: number, beats = 4): Promise<void> {
  const ac = audio();
  const spb = 60 / bpm;
  const t0 = ac.currentTime + 0.08;
  for (let i = 0; i < beats; i++) click(t0 + i * spb, i === 0);
  return new Promise((r) => window.setTimeout(r, (0.08 + beats * spb) * 1000 - 40));
}

/** Nearest beat to `t` on the tempo grid. */
export function snapToBeat(t: number, tp: Tempo): number {
  const spb = 60 / tp.bpm;
  return Math.max(0, Math.round((tp.downbeat + Math.round((t - tp.downbeat) / spb) * spb) * 100) / 100);
}

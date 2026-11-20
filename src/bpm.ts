/* Finding a song's BPM without an API key: video name, video description, a music database, or by listening. */
import { bpmFromTitle } from "./metronome";
import { SongKey, addChroma, keyFromChroma } from "./key";

export type BpmSource = "video name" | "description" | "song database" | "audio";
export interface FoundBpm {
  bpm: number;
  from: BpmSource;
  /** Song time of a likely bar start (audio detection only). */
  downbeat?: number;
}

/** BPM mentioned in free text: "140 BPM", "bpm: 92", "Tempo: 88". */
export function bpmInText(text: string): number | null {
  const direct = bpmFromTitle(text);
  if (direct) return direct;
  const m = text.match(/\btempo\s*[:\-]?\s*(\d{2,3}(?:\.\d)?)\b/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return n >= 40 && n <= 220 ? n : null;
}

// Public YouTube mirrors. YouTube often blocks these, so this is a quick best-effort check only.
const PIPED = ["https://api.piped.private.coffee", "https://pipedapi.kavin.rocks"];

async function fetchJson(url: string, ms = 6000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(String(r.status));
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/** The YouTube description, via public Piped mirrors (tries a few). */
export async function videoDescription(videoId: string): Promise<string | null> {
  for (const base of PIPED) {
    try {
      const j = await fetchJson(`${base}/streams/${videoId}`, 3500);
      if (typeof j?.description === "string") return j.description.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ");
    } catch {
      /* try the next mirror */
    }
  }
  return null;
}

function jsonp(url: string, ms = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    const cb = `__ib${Math.random().toString(36).slice(2)}`;
    const s = document.createElement("script");
    const done = () => {
      delete (window as any)[cb];
      s.remove();
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error("timeout"));
    }, ms);
    (window as any)[cb] = (d: any) => {
      done();
      resolve(d);
    };
    s.onerror = () => {
      done();
      reject(new Error("load"));
    };
    s.src = `${url}${url.includes("?") ? "&" : "?"}output=jsonp&callback=${cb}`;
    document.head.appendChild(s);
  });
}

/** A real song's BPM from Deezer's catalogue (free, no key). */
export async function songDatabaseBpm(track: string, artist: string): Promise<number | null> {
  try {
    const q = `${track} ${artist}`.replace(/\(.*?\)|\[.*?\]/g, " ").replace(/\s+/g, " ").trim();
    const s = await jsonp(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=5`);
    for (const hit of (s?.data ?? []).slice(0, 3)) {
      const tr = await jsonp(`https://api.deezer.com/track/${hit.id}`);
      if (tr?.bpm > 40) return Math.round(tr.bpm);
    }
  } catch {
    /* database unreachable */
  }
  return null;
}

/** Name, then description, then (for covers) the song database. */
export async function findBpm(opts: {
  videoTitle: string;
  videoId: string;
  cover?: { track: string; artist: string } | null;
}): Promise<FoundBpm | null> {
  if (opts.cover) {
    const b = await songDatabaseBpm(opts.cover.track, opts.cover.artist);
    if (b) return { bpm: b, from: "song database" };
  }
  const fromName = bpmInText(opts.videoTitle);
  if (fromName) return { bpm: fromName, from: "video name" };
  if (opts.videoId) {
    const desc = await videoDescription(opts.videoId);
    const fromDesc = desc ? bpmInText(desc) : null;
    if (fromDesc) return { bpm: fromDesc, from: "description" };
  }
  return null;
}

/* ---------------- Listening: tempo from the actual audio ---------------- */

/**
 * Collects an onset (attack) envelope from a live audio stream for `seconds`, then estimates
 * BPM by autocorrelation and the beat/bar phase with comb filters.
 * `songAt(ctxTime)` maps the audio clock to song time so the bar start lands on the timeline.
 */
export async function detectFromStream(
  stream: MediaStream,
  seconds: number,
  songAt: (ctxTime: number, ctx: AudioContext) => number,
  onProgress?: (p: number) => void
): Promise<{ bpm: number; downbeat: number; key: SongKey | null; chroma: number[] } | null> {
  const ctx = new AudioContext();
  await ctx.resume();
  const src = ctx.createMediaStreamSource(stream);
  const low = ctx.createBiquadFilter();
  low.type = "lowpass";
  low.frequency.value = 160;
  const hop = 512;
  const procFull = ctx.createScriptProcessor(hop, 1, 1);
  const procLow = ctx.createScriptProcessor(hop, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(procFull);
  src.connect(low).connect(procLow);
  procFull.connect(mute);
  procLow.connect(mute);
  mute.connect(ctx.destination);

  // Pitch content for the key: sample the spectrum ~10x a second.
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 8192;
  analyser.smoothingTimeConstant = 0;
  src.connect(analyser);
  const spec = new Float32Array(analyser.frequencyBinCount);
  const chroma = new Array(12).fill(0);
  const chromaTimer = setInterval(() => {
    analyser.getFloatFrequencyData(spec);
    addChroma(chroma, spec, ctx.sampleRate, analyser.fftSize);
  }, 100);

  const full: number[] = [];
  const lowE: number[] = [];
  let t0 = -1;
  const energy = (d: Float32Array) => {
    let s = 0;
    for (let i = 0; i < d.length; i++) s += d[i] * d[i];
    return s / d.length;
  };
  procFull.onaudioprocess = (e) => {
    if (t0 < 0) t0 = e.playbackTime;
    full.push(energy(e.inputBuffer.getChannelData(0)));
  };
  procLow.onaudioprocess = (e) => {
    lowE.push(energy(e.inputBuffer.getChannelData(0)));
  };

  const start = performance.now();
  await new Promise<void>((resolve) => {
    const tick = setInterval(() => {
      const p = (performance.now() - start) / (seconds * 1000);
      onProgress?.(Math.min(1, p));
      if (p >= 1) {
        clearInterval(tick);
        resolve();
      }
    }, 100);
  });
  clearInterval(chromaTimer);
  procFull.disconnect();
  procLow.disconnect();
  src.disconnect();
  const keyRes = keyFromChroma(chroma);
  const key = keyRes && keyRes.confidence > 0.02 ? keyRes.key : null;

  const n = Math.min(full.length, lowE.length);
  if (n < 200 || t0 < 0) {
    await ctx.close();
    return null;
  }
  const songStart = songAt(t0, ctx);
  const frames = ctx.sampleRate / hop; // onset frames per second
  await ctx.close();

  const tp = tempoFromEnergy(full, lowE, frames);
  if (!tp) return null;
  const { bpm, barPhase } = tp;
  const LATENCY = 0.045; // measured: script-processor timing lands ~45ms late
  const downbeat = songStart + barPhase / frames - LATENCY;
  return { bpm, downbeat: Math.max(0, Math.round(downbeat * 1000) / 1000), key, chroma };
}

/** Asks Chrome to share this tab's audio. Returns null if the user cancels or no audio was shared. */
export async function captureTabAudio(): Promise<MediaStream | null> {
  const md: any = navigator.mediaDevices;
  if (!md?.getDisplayMedia) return null;
  const stream: MediaStream = await md.getDisplayMedia({
    video: true,
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    preferCurrentTab: true,
    selfBrowserSurface: "include",
    systemAudio: "include",
  });
  if (!stream.getAudioTracks().length) {
    stream.getTracks().forEach((t) => t.stop());
    return null;
  }
  return stream; // caller stops all tracks when done (stopping video early can end the share)
}

/**
 * Tempo and bar phase from per-hop energies (whole band + kick band).
 * `frames` = hops per second. Returns the BPM and the bar start, in hops from the first hop.
 */
export function tempoFromEnergy(full: number[], lowE: number[], frames: number): { bpm: number; barPhase: number } | null {
  const n = Math.min(full.length, lowE.length);
  if (n < 200) return null;
  // Onset strength: rectified log-energy rise, kick band weighted up.
  const onset = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const a = Math.max(0, Math.log1p(full[i] * 1e4) - Math.log1p(full[i - 1] * 1e4));
    const b = Math.max(0, Math.log1p(lowE[i] * 1e4) - Math.log1p(lowE[i - 1] * 1e4));
    onset[i] = a + 2 * b;
  }
  const mean = onset.reduce((x, y) => x + y, 0) / n;
  for (let i = 0; i < n; i++) onset[i] = Math.max(0, onset[i] - mean);
  if (onset.every((v) => v === 0)) return null;


  // Autocorrelation over 60–200 BPM, weighted toward ~100 BPM to settle half/double-time.
  let best = 0;
  let bestLag = 0;
  const ac = (lag: number) => {
    let s = 0;
    for (let i = lag; i < n; i++) s += onset[i] * onset[i - lag];
    return s / (n - lag);
  };
  const minLag = Math.floor((60 * frames) / 200);
  const maxLag = Math.ceil((60 * frames) / 60);
  const scores: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * frames) / lag;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 100) / 0.9, 2));
    const sc = ac(lag) * w;
    scores[lag] = sc;
    if (sc > best) {
      best = sc;
      bestLag = lag;
    }
  }
  if (!bestLag) return null;
  // Parabolic refinement for sub-frame accuracy.
  const y0 = scores[bestLag - 1] ?? best;
  const y2 = scores[bestLag + 1] ?? best;
  const shift = (y0 - y2) / (2 * (y0 - 2 * best + y2) || 1);
  const period = bestLag + (Math.abs(shift) < 1 ? shift : 0);
  let bpm = (60 * frames) / period;
  bpm = Math.round(bpm); // beats are almost always made at whole-number tempos

  // Beat phase, then which of the 4 beats is strongest (likely "1").
  const comb = (offset: number, step: number) => {
    let s = 0;
    for (let x = offset; x < n; x += step) s += onset[Math.round(x)] || 0;
    return s;
  };
  let phase = 0;
  let phaseScore = -1;
  for (let o = 0; o < period; o++) {
    const sc = comb(o, period);
    if (sc > phaseScore) {
      phaseScore = sc;
      phase = o;
    }
  }
  let barPhase = phase;
  let barScore = -1;
  for (let k = 0; k < 4; k++) {
    const sc = comb(phase + k * period, period * 4);
    if (sc > barScore) {
      barScore = sc;
      barPhase = phase + k * period;
    }
  }
  return { bpm, barPhase };
}

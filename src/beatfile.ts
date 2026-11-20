/* Your own beat file: a player that acts like the YouTube one, a waveform, and offline BPM/key analysis. */
import type { YTPlayer } from "./youtube";
import { tempoFromEnergy } from "./bpm";
import { SongKey, addChroma, keyFromChroma } from "./key";

/** Wraps an <audio> element in the same calls the app uses on the YouTube player. */
export class FilePlayer implements YTPlayer {
  audio: HTMLAudioElement;
  private url: string;
  name: string;
  constructor(blob: Blob, name: string) {
    this.url = URL.createObjectURL(blob);
    this.audio = new Audio(this.url);
    this.audio.preload = "auto";
    this.name = name;
  }
  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.audio.readyState >= 1) return resolve();
      this.audio.addEventListener("loadedmetadata", () => resolve(), { once: true });
      this.audio.addEventListener("error", () => reject(new Error("decode")), { once: true });
    });
  }
  playVideo() {
    this.audio.play().catch(() => {});
  }
  pauseVideo() {
    this.audio.pause();
  }
  seekTo(s: number) {
    this.audio.currentTime = Math.max(0, Math.min(s, this.getDuration() || s));
  }
  getCurrentTime() {
    return this.audio.currentTime;
  }
  getDuration() {
    return isFinite(this.audio.duration) ? this.audio.duration : 0;
  }
  getPlayerState() {
    if (this.audio.ended) return 0;
    return this.audio.paused ? 2 : 1;
  }
  setVolume(v: number) {
    this.audio.volume = Math.max(0, Math.min(1, v / 100));
  }
  getVolume() {
    return this.audio.volume * 100;
  }
  mute() {
    this.audio.muted = true;
  }
  unMute() {
    this.audio.muted = false;
  }
  loadVideoById() {}
  cueVideoById() {}
  getVideoData() {
    return { title: this.name, video_id: "" };
  }
  destroy() {
    this.audio.pause();
    this.audio.removeAttribute("src");
    URL.revokeObjectURL(this.url);
  }
}

export const BEAT_TYPES = "audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.webm";

/** File name without the extension, tidied for a song title. */
export function titleFromFile(name: string): string {
  return name.replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[_]+/g, " ").trim() || "Untitled song";
}

let ctx: AudioContext | null = null;
function ac() {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

export async function decodeFile(blob: Blob): Promise<AudioBuffer> {
  return ac().decodeAudioData(await blob.arrayBuffer());
}

/** Peak heights (0..1) in `buckets` columns for drawing the waveform. */
export function peaks(buf: AudioBuffer, buckets = 1600): Float32Array {
  const out = new Float32Array(buckets);
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const per = Math.max(1, Math.floor(buf.length / buckets));
  let max = 0;
  for (let b = 0; b < buckets; b++) {
    let m = 0;
    const from = b * per;
    const to = Math.min(buf.length, from + per);
    for (let i = from; i < to; i += 4) for (const ch of chans) m = Math.max(m, Math.abs(ch[i]));
    out[b] = m;
    max = Math.max(max, m);
  }
  if (max > 0) for (let b = 0; b < buckets; b++) out[b] /= max;
  return out;
}

function mono(buf: AudioBuffer): Float32Array {
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels;
  }
  return out;
}

/** In-place radix-2 FFT. */
function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

/** BPM, first bar start and key, straight from the file (no tab sharing). */
export async function analyzeBeat(buf: AudioBuffer): Promise<{ bpm: number; downbeat: number; key: SongKey | null } | null> {
  const rate = buf.sampleRate;
  const hop = 512;
  // Look at up to 4 minutes.
  const len = Math.min(buf.length, Math.floor(rate * 240));
  const m = mono(buf).subarray(0, len);

  // Kick band via an offline low-pass.
  const off = new OfflineAudioContext(1, len, rate);
  const src = off.createBufferSource();
  const one = off.createBuffer(1, len, rate);
  one.copyToChannel(m, 0);
  src.buffer = one;
  const low = off.createBiquadFilter();
  low.type = "lowpass";
  low.frequency.value = 160;
  src.connect(low).connect(off.destination);
  src.start();
  const lowBuf = (await off.startRendering()).getChannelData(0);

  const full: number[] = [];
  const lowE: number[] = [];
  for (let i = 0; i + hop <= len; i += hop) {
    let a = 0;
    let b = 0;
    for (let k = i; k < i + hop; k++) {
      a += m[k] * m[k];
      b += lowBuf[k] * lowBuf[k];
    }
    full.push(a / hop);
    lowE.push(b / hop);
  }
  const tp = tempoFromEnergy(full, lowE, rate / hop);

  // Key: spectrum every half second.
  const N = 8192;
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const db = new Float32Array(N / 2);
  const chroma = new Array(12).fill(0);
  for (let i = 0; i + N <= len; i += Math.floor(rate / 2)) {
    for (let k = 0; k < N; k++) {
      re[k] = m[i + k] * win[k];
      im[k] = 0;
    }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) db[k] = 10 * Math.log10((re[k] * re[k] + im[k] * im[k]) / N + 1e-12);
    addChroma(chroma, db, rate, N);
  }
  const kr = keyFromChroma(chroma);
  const key = kr && kr.confidence > 0.02 ? kr.key : null;
  if (!tp) return key ? { bpm: 0, downbeat: 0, key } : null;
  return { bpm: tp.bpm, downbeat: Math.round(((tp.barPhase * hop) / rate) * 1000) / 1000, key };
}

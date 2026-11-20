/* Decode, splice, mix and encode recorded takes. */
import type { TakeFx } from "./db";
import { renderFx } from "./fx";

let ctx: AudioContext | null = null;
function ac(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

export async function decode(blob: Blob): Promise<Float32Array & { rate?: number }> {
  const buf = await ac().decodeAudioData(await blob.arrayBuffer());
  // Mix down to mono.
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels;
  }
  return out;
}

export function sampleRate(): number {
  return ac().sampleRate;
}

export function encodeWav(samples: Float32Array, rate: number): Blob {
  const len = samples.length;
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + len * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, len * 2, true);
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

/**
 * Replaces [punchIn, punchOut) of the original take (song times) with the new recording.
 * `origStart` / `recStart` are the song times of each clip's first sample.
 */
export async function splicePunch(
  original: Blob,
  origStart: number,
  recording: Blob,
  recStart: number,
  punchIn: number,
  punchOut: number
): Promise<{ blob: Blob; duration: number }> {
  const rate = sampleRate();
  const [o, r] = await Promise.all([decode(original), decode(recording)]);
  const at = (songT: number, clipStart: number) => Math.round((songT - clipStart) * rate);
  const inO = Math.max(0, at(punchIn, origStart));
  const outO = Math.max(inO, at(punchOut, origStart));
  const len = Math.max(o.length, outO);
  const out = new Float32Array(len);
  out.set(o.subarray(0, Math.min(inO, o.length)), 0);
  const fade = Math.round(rate * 0.012);
  for (let i = inO; i < outO; i++) {
    const ri = at(punchIn, recStart) + (i - inO);
    const nv = ri >= 0 && ri < r.length ? r[ri] : 0;
    // Short crossfades at both edges so the punch doesn't click.
    const w = Math.min(1, (i - inO) / fade, (outO - i) / fade);
    const ov = i < o.length ? o[i] : 0;
    out[i] = nv * w + ov * (1 - w);
  }
  if (outO < o.length) out.set(o.subarray(outO), outO);
  return { blob: encodeWav(out, rate), duration: len / rate };
}

export function encodeWavStereo(l: Float32Array, r: Float32Array, rate: number): Blob {
  const len = l.length;
  const buf = new ArrayBuffer(44 + len * 4);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + len * 4, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, len * 4, true);
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < 2; c++) {
      const s = Math.max(-1, Math.min(1, (c ? r : l)[i]));
      v.setInt16(44 + i * 4 + c * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }
  return new Blob([buf], { type: "audio/wav" });
}

/**
 * Lays takes out on one timeline from song time 0, so the file lines up with the beat.
 * Each take goes through its sound settings. With `beat`, the beat file is mixed in too.
 */
export async function mixTakes(
  takes: { blob: Blob; start: number; duration: number; fx?: TakeFx }[],
  beat?: { blob: Blob; gain: number } | null
): Promise<Blob> {
  const rate = sampleRate();
  const clips = await Promise.all(
    takes.map(async (t) => ({ t, buf: await renderFx(await ac().decodeAudioData(await t.blob.arrayBuffer()), t.fx) }))
  );
  const beatBuf = beat ? await ac().decodeAudioData(await beat.blob.arrayBuffer()) : null;
  let end = beatBuf ? beatBuf.length : 0;
  for (const { t, buf } of clips) end = Math.max(end, Math.max(0, t.start) * rate + buf.length);
  const L = new Float32Array(Math.ceil(end));
  const R = new Float32Array(Math.ceil(end));
  const lay = (buf: AudioBuffer, start: number, gain: number) => {
    let off = Math.round(start * rate);
    let from = 0;
    if (off < 0) {
      from = -off;
      off = 0;
    }
    const a = buf.getChannelData(0);
    const b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
    for (let i = from; i < buf.length && off + i - from < L.length; i++) {
      L[off + i - from] += a[i] * gain;
      R[off + i - from] += b[i] * gain;
    }
  };
  if (beatBuf) lay(beatBuf, 0, beat!.gain);
  for (const { t, buf } of clips) lay(buf, t.start, 1);
  // Keep it from clipping where things overlap.
  let peak = 0;
  for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  if (peak > 0.98) {
    const k = 0.98 / peak;
    for (let i = 0; i < L.length; i++) {
      L[i] *= k;
      R[i] *= k;
    }
  }
  return encodeWavStereo(L, R, rate);
}

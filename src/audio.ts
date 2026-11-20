/* Decode, splice, mix and encode recorded takes (mono WAV out). */

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

/** Lays takes out on one timeline from song time 0, so the file lines up with the beat. */
export async function mixTakes(takes: { blob: Blob; start: number; duration: number }[]): Promise<Blob> {
  const rate = sampleRate();
  const decoded = await Promise.all(takes.map(async (t) => ({ t, data: await decode(t.blob) })));
  const end = Math.max(...decoded.map(({ t, data }) => Math.max(0, t.start) * rate + data.length));
  const out = new Float32Array(Math.ceil(end));
  for (const { t, data } of decoded) {
    let off = Math.round(t.start * rate);
    let from = 0;
    if (off < 0) {
      from = -off;
      off = 0;
    }
    for (let i = from; i < data.length; i++) out[off + i - from] += data[i];
  }
  // Keep it from clipping where takes overlap.
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak > 0.98) for (let i = 0; i < out.length; i++) out[i] *= 0.98 / peak;
  return encodeWav(out, rate);
}

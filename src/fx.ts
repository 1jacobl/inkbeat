/* Per-take sound: volume, bass, treble and reverb. Same chain live (playback) and offline (export). */
import { NO_FX, TakeFx } from "./db";

let ctx: AudioContext | null = null;
export function playCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

const impulses = new WeakMap<BaseAudioContext, AudioBuffer>();
/** A soft room: two seconds of decaying noise. */
function impulse(c: BaseAudioContext): AudioBuffer {
  const have = impulses.get(c);
  if (have) return have;
  const len = Math.floor(c.sampleRate * 2.2);
  const buf = c.createBuffer(2, len, c.sampleRate);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = rnd() * Math.pow(1 - i / len, 3.2);
  }
  impulses.set(c, buf);
  return buf;
}

export function isFlat(fx?: TakeFx) {
  return !fx || (fx.gain === 0 && fx.low === 0 && fx.high === 0 && fx.reverb === 0);
}

interface Chain {
  input: AudioNode;
  output: AudioNode;
  set(fx: TakeFx): void;
}

function chain(c: BaseAudioContext, fx: TakeFx): Chain {
  const low = c.createBiquadFilter();
  low.type = "lowshelf";
  low.frequency.value = 200;
  const high = c.createBiquadFilter();
  high.type = "highshelf";
  high.frequency.value = 4000;
  const gain = c.createGain();
  const dry = c.createGain();
  const wet = c.createGain();
  const verb = c.createConvolver();
  verb.buffer = impulse(c);
  const out = c.createGain();
  low.connect(high).connect(gain);
  gain.connect(dry).connect(out);
  gain.connect(verb).connect(wet).connect(out);
  const set = (f: TakeFx) => {
    low.gain.value = f.low;
    high.gain.value = f.high;
    gain.gain.value = Math.pow(10, f.gain / 20);
    dry.gain.value = 1 - f.reverb * 0.45;
    wet.gain.value = f.reverb * 0.6;
  };
  set(fx);
  return { input: low, output: out, set };
}

/** Sends an <audio> element through the take's sound settings. Returns a live handle. */
export function routeAudio(audio: HTMLAudioElement, fx: TakeFx = NO_FX): { set(fx: TakeFx): void } {
  const c = playCtx();
  const src = c.createMediaElementSource(audio);
  const ch = chain(c, fx);
  src.connect(ch.input);
  ch.output.connect(c.destination);
  return { set: ch.set };
}

/** Renders a decoded clip through its sound settings (stereo, plus reverb tail). */
export async function renderFx(clip: AudioBuffer, fx: TakeFx = NO_FX): Promise<AudioBuffer> {
  if (isFlat(fx)) return clip;
  const tail = fx.reverb > 0 ? 2.2 : 0;
  const off = new OfflineAudioContext(2, clip.length + Math.ceil(tail * clip.sampleRate), clip.sampleRate);
  const src = off.createBufferSource();
  src.buffer = clip;
  const ch = chain(off, fx);
  src.connect(ch.input);
  ch.output.connect(off.destination);
  src.start();
  return off.startRendering();
}

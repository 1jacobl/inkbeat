/* Live pitch line: the note you're singing, drawn against the song's key while you record. */
import { useEffect, useRef } from "react";
import { SongKey, noteNames } from "./key";

/** YIN pitch estimate in Hz, or 0 for silence / no clear pitch. */
export function detectPitch(buf: Float32Array, rate: number): number {
  let rms = 0;
  for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / buf.length);
  if (rms < 0.012) return 0;
  const minLag = Math.floor(rate / 1000);
  const maxLag = Math.min(Math.floor(rate / 70), Math.floor(buf.length / 2));
  const W = buf.length - maxLag;
  const d = new Float32Array(maxLag + 1);
  for (let lag = 1; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i < W; i++) {
      const x = buf[i] - buf[i + lag];
      s += x * x;
    }
    d[lag] = s;
  }
  // Cumulative mean normalised difference.
  let run = 0;
  let best = -1;
  const cm = new Float32Array(maxLag + 1);
  cm[0] = 1;
  for (let lag = 1; lag <= maxLag; lag++) {
    run += d[lag];
    cm[lag] = run ? (d[lag] * lag) / run : 1;
  }
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (cm[lag] < 0.15) {
      while (lag + 1 <= maxLag && cm[lag + 1] < cm[lag]) lag++;
      best = lag;
      break;
    }
  }
  if (best < 0) return 0;
  const a = cm[best - 1] ?? cm[best];
  const b = cm[best];
  const c = cm[best + 1] ?? cm[best];
  const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
  return rate / (best + (Math.abs(shift) < 1 ? shift : 0));
}

const SPAN = 8; // seconds shown
const RANGE = 17; // semitones visible

export default function PitchLine({ stream, songKey }: { stream: MediaStream | null; songKey: SongKey | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!stream || !canvas.current) return;
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const pts: { t: number; midi: number }[] = [];
    let center = 57; // A3, slides toward your voice
    let raf = 0;
    const cv = canvas.current;
    const g = cv.getContext("2d")!;
    const css = getComputedStyle(cv);
    const ink = css.getPropertyValue("--pitch-ink").trim() || "#111";
    const off = css.getPropertyValue("--pitch-off").trim() || "#e5484d";
    const lane = css.getPropertyValue("--pitch-lane").trim() || "rgba(0,0,0,.08)";
    const tonicLane = css.getPropertyValue("--pitch-tonic").trim() || "rgba(0,0,0,.18)";
    const scale = songKey ? new Set((songKey.mode === "major" ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10]).map((s) => (songKey.tonic + s) % 12)) : null;
    const names = songKey ? noteNames(songKey) : ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

    const draw = () => {
      const now = performance.now() / 1000;
      an.getFloatTimeDomainData(buf);
      const hz = detectPitch(buf, ctx.sampleRate);
      if (hz) {
        const midi = 69 + 12 * Math.log2(hz / 440);
        pts.push({ t: now, midi });
        center += (midi - center) * 0.02;
      } else pts.push({ t: now, midi: NaN });
      while (pts.length && pts[0].t < now - SPAN) pts.shift();

      const dpr = window.devicePixelRatio || 1;
      const W = cv.clientWidth;
      const H = cv.clientHeight;
      if (cv.width !== W * dpr || cv.height !== H * dpr) {
        cv.width = W * dpr;
        cv.height = H * dpr;
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const lo = Math.round(center) - Math.floor(RANGE / 2);
      const y = (m: number) => H - ((m - lo + 0.5) / RANGE) * H;
      g.font = "10px 'JetBrains Mono', monospace";
      g.textBaseline = "middle";
      let lastLabel = -99;
      for (let m = lo; m < lo + RANGE; m++) {
        const pc = ((m % 12) + 12) % 12;
        const inKey = !scale || scale.has(pc);
        if (!inKey) continue;
        const label = m - lastLabel > 1;
        g.fillStyle = songKey && pc === songKey.tonic ? tonicLane : lane;
        g.fillRect(28, y(m) - H / RANGE / 2 + 1, W - 28, H / RANGE - 2);
        if (!label) continue;
        lastLabel = m;
        g.fillStyle = ink;
        g.globalAlpha = 0.55;
        g.fillText(names[pc] + (pc === 0 ? Math.floor(m / 12) - 1 : ""), 2, y(m));
        g.globalAlpha = 1;
      }
      g.lineWidth = 3;
      g.lineCap = "round";
      let prev: { x: number; y: number } | null = null;
      for (const p of pts) {
        if (isNaN(p.midi)) {
          prev = null;
          continue;
        }
        const x = 28 + ((p.t - (now - SPAN)) / SPAN) * (W - 28);
        const yy = y(p.midi);
        const pc = ((Math.round(p.midi) % 12) + 12) % 12;
        g.strokeStyle = !scale || scale.has(pc) ? ink : off;
        if (prev) {
          g.beginPath();
          g.moveTo(prev.x, prev.y);
          g.lineTo(x, yy);
          g.stroke();
        }
        prev = { x, y: yy };
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      src.disconnect();
      ctx.close();
    };
  }, [stream, songKey?.tonic, songKey?.mode]);

  return (
    <div className="pitch">
      <div className="pitch-head">
        <span>Your pitch</span>
        <span className="pitch-key">{songKey ? `lanes = notes in the key · red = off key` : "set a song key to see which notes fit"}</span>
      </div>
      <canvas ref={canvas} className="pitch-canvas" />
    </div>
  );
}

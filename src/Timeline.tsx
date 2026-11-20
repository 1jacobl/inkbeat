import { useRef, useState } from "react";
import type { Marker, Take } from "./db";
import { useClock } from "./clock";
import { fmt } from "./time";

interface Props {
  markers: Marker[];
  takes: Take[];
  activeId: string | null;
  recMarkerId: string | null;
  onSeek: (t: number) => void;
  onMoveMarker: (id: string, t: number) => void;
  loop: { start: number; end: number } | null;
  tempo: { bpm: number; downbeat: number; beatsPerBar: number } | null;
  /** Waveform of an uploaded beat file. */
  peaks?: Float32Array | null;
}

/**
 * A tape strip: the whole beat, with marker flags above and recorded flows below.
 * Drag the strip to scrub; drag a flag to move that section; click a flag to jump to it.
 */
export default function Timeline({ markers, takes, activeId, recMarkerId, onSeek, onMoveMarker, loop, tempo, peaks }: Props) {
  const duration = useClock((s) => Math.floor(s.duration * 10) / 10);
  const head = useClock((s) => (s.duration ? Math.round((s.now / s.duration) * 2000) / 20 : 0));
  const ref = useRef<HTMLDivElement>(null);
  const [scrub, setScrub] = useState<number | null>(null); // pct while scrubbing, so the head follows the finger
  const [drag, setDrag] = useState<{ id: string; t: number; moved: boolean; x0: number } | null>(null);
  const lastSeek = useRef(0);

  const pct = (t: number) => (duration ? Math.max(0, Math.min(100, (t / duration) * 100)) : 0);
  const timeAt = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || !duration) return 0;
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
  };

  /* ---- scrubbing the strip ---- */
  const scrubTo = (clientX: number, force = false) => {
    const t = timeAt(clientX);
    setScrub(pct(t));
    const now = performance.now();
    if (force || now - lastSeek.current > 80) {
      lastSeek.current = now;
      onSeek(t);
    }
  };

  return (
    <div className={`timeline ${scrub !== null || drag ? "dragging" : ""}`}>
      <div
        className="tape"
        ref={ref}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest(".flag") || e.button !== 0) return;
          e.preventDefault();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          scrubTo(e.clientX, true);
        }}
        onPointerMove={(e) => {
          if (scrub === null) return;
          scrubTo(e.clientX);
        }}
        onPointerUp={(e) => {
          if (scrub === null) return;
          scrubTo(e.clientX, true);
          setScrub(null);
        }}
        onPointerCancel={() => setScrub(null)}
        role="slider"
        aria-label="Beat position"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={Math.round((head / 100) * duration)}
      >
        {tempo && duration ? (
          <BarLines tempo={tempo} duration={duration} />
        ) : (
          <div className="ticks" />
        )}
        <div className="played" style={{ width: `${scrub ?? head}%` }} />
        {peaks && <Wave peaks={peaks} />}
        {loop && (
          <div className="loop-zone" style={{ left: `${pct(loop.start)}%`, width: `${pct(loop.end) - pct(loop.start)}%` }} />
        )}
        {takes.map((t) => (
          <div
            key={t.id}
            className="take-seg"
            style={{ left: `${pct(t.start)}%`, width: `${Math.max(0.4, pct(t.duration))}%` }}
            title={`${t.name} · ${fmt(t.start)}`}
          />
        ))}
        {markers.map((m, i) => {
          const dragging = drag?.id === m.id;
          const t = dragging ? drag.t : m.time;
          return (
            <button
              key={m.id}
              className={`flag ${m.id === activeId ? "on" : ""} ${m.id === recMarkerId ? "rec" : ""} ${dragging && drag.moved ? "held" : ""}`}
              style={{ left: `${pct(t)}%` }}
              title={`${m.label || `Section ${i + 1}`} · ${fmt(m.time)} · drag to move`}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                setDrag({ id: m.id, t: m.time, moved: false, x0: e.clientX });
              }}
              onPointerMove={(e) => {
                if (!dragging) return;
                const moved = drag.moved || Math.abs(e.clientX - drag.x0) > 4;
                if (moved) setDrag({ ...drag, moved, t: Math.round(timeAt(e.clientX) * 10) / 10 });
              }}
              onPointerUp={() => {
                if (!dragging) return;
                if (drag.moved) onMoveMarker(m.id, drag.t);
                else onSeek(m.time);
                setDrag(null);
              }}
              onPointerCancel={() => setDrag(null)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSeek(m.time);
                }
              }}
            >
              <span>{dragging && drag.moved ? fmt(drag.t, true) : m.label ? m.label.slice(0, 10) : i + 1}</span>
            </button>
          );
        })}
        <div className="head" style={{ left: `${scrub ?? head}%` }} />
      </div>
      <div className="tape-scale">
        <span>0:00</span>
        <span>{fmt(duration / 2)}</span>
        <span>{fmt(duration)}</span>
      </div>
    </div>
  );
}

function BarLines({ tempo, duration }: { tempo: { bpm: number; downbeat: number; beatsPerBar: number }; duration: number }) {
  const bar = (60 / tempo.bpm) * tempo.beatsPerBar;
  const lines: { t: number; n: number }[] = [];
  let n = Math.ceil(-tempo.downbeat / bar);
  for (let t = tempo.downbeat + n * bar; t <= duration && lines.length < 400; t += bar, n++) if (t >= 0) lines.push({ t, n });
  const every = lines.length > 120 ? 4 : 1; // thin out on long songs
  return (
    <div className="bars" aria-hidden>
      {lines.map((l) =>
        l.n % every === 0 ? (
          <i key={l.n} className={l.n % 4 === 0 ? "four" : ""} style={{ left: `${(l.t / duration) * 100}%` }} />
        ) : null
      )}
    </div>
  );
}

/** Mirrored waveform drawn as one SVG path, stretched across the strip. */
export function Wave({ peaks, className = "wave" }: { peaks: Float32Array; className?: string }) {
  const n = peaks.length;
  let top = "M0 50";
  let bot = "";
  for (let i = 0; i < n; i += 2) {
    const h = Math.max(0.6, peaks[i] * 48);
    top += ` L${i} ${50 - h}`;
    bot = ` L${i} ${50 + h}` + bot;
  }
  return (
    <svg className={className} viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" aria-hidden>
      <path d={`${top} L${n} 50${bot} Z`} />
    </svg>
  );
}

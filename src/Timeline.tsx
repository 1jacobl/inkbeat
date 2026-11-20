import { useRef } from "react";
import type { Marker, Take } from "./db";
import { useClock } from "./clock";
import { fmt } from "./time";

interface Props {
  markers: Marker[];
  takes: Take[];
  activeId: string | null;
  recMarkerId: string | null;
  onSeek: (t: number) => void;
  loop: { start: number; end: number } | null;
}

/** A tape strip: the whole beat, with marker flags above and recorded flows below. */
export default function Timeline({ markers, takes, activeId, recMarkerId, onSeek, loop }: Props) {
  const duration = useClock((s) => Math.floor(s.duration));
  const head = useClock((s) => (s.duration ? Math.round((s.now / s.duration) * 2000) / 20 : 0));
  const ref = useRef<HTMLDivElement>(null);

  const pct = (t: number) => (duration ? Math.min(100, (t / duration) * 100) : 0);

  const seekFromPointer = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || !duration) return;
    onSeek(((clientX - r.left) / r.width) * duration);
  };

  return (
    <div className="timeline">
      <div
        className="tape"
        ref={ref}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest(".flag")) return;
          seekFromPointer(e.clientX);
        }}
        role="slider"
        aria-label="Beat position"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={Math.round((head / 100) * duration)}
      >
        <div className="ticks" />
        <div className="played" style={{ width: `${head}%` }} />
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
        {markers.map((m, i) => (
          <button
            key={m.id}
            className={`flag ${m.id === activeId ? "on" : ""} ${m.id === recMarkerId ? "rec" : ""}`}
            style={{ left: `${pct(m.time)}%` }}
            onClick={() => onSeek(m.time)}
            title={`${m.label || `Marker ${i + 1}`} · ${fmt(m.time)}`}
          >
            <span>{m.label ? m.label.slice(0, 10) : i + 1}</span>
          </button>
        ))}
        <div className="head" style={{ left: `${head}%` }} />
      </div>
      <div className="tape-scale">
        <span>0:00</span>
        <span>{fmt(duration / 2)}</span>
        <span>{fmt(duration)}</span>
      </div>
    </div>
  );
}

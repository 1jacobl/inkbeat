import { marquee } from "./marquee";
import { useEffect, useMemo, useRef } from "react";
import type { Marker } from "./db";
import { useClock } from "./clock";
import { fmt } from "./time";

interface Props {
  title: string;
  markers: Marker[];
  duration: number;
  onTogglePlay: () => void;
  onSeek: (t: number) => void;
  onClose: () => void;
}

interface Line {
  key: string;
  section: number;
  text: string;
  t: number; // when this line starts (song time)
}

/**
 * Full-screen teleprompter. Line timing: in cover mode each line uses the original line's
 * time; otherwise lines are spread evenly across their section.
 */
export default function Perform({ title, markers, duration, onTogglePlay, onSeek, onClose }: Props) {
  const lines = useMemo(() => {
    const out: Line[] = [];
    markers.forEach((m, si) => {
      const text = m.lyrics.split("\n").map((l) => l.trim()).filter(Boolean);
      if (!text.length) return;
      const end = markers[si + 1]?.time ?? Math.min(duration || m.time + 20, m.time + 20);
      const span = Math.max(1, end - m.time);
      text.forEach((l, i) => {
        const orig = m.original?.[i]?.t;
        out.push({ key: `${m.id}-${i}`, section: si, text: l, t: orig ?? m.time + (span * i) / text.length });
      });
    });
    return out.sort((a, b) => a.t - b.t);
  }, [markers, duration]);

  const cur = useClock((s) => {
    let idx = -1;
    for (let i = 0; i < lines.length; i++) if (lines[i].t <= s.now + 0.1) idx = i;
    return idx;
  });
  const now = useClock((s) => Math.floor(s.now));
  const playing = useClock((s) => s.playing);

  const refs = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    const l = lines[Math.max(0, cur)];
    if (l) refs.current.get(l.key)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [cur, lines]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    document.documentElement.requestFullscreen?.().catch(() => {});
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, [onClose]);

  return (
    <div className="perform" role="dialog" aria-label="Performance view">
      <header className="perform-bar">
        <span className="perform-title" {...marquee}>{title}</span>
        <span className="perform-time">
          {fmt(now)} / {fmt(duration)}
        </span>
        <button className="perform-play" onClick={onTogglePlay} aria-label={playing ? "Pause" : "Play"}>
          {playing ? "❚❚" : "▶"}
        </button>
        <button className="perform-x" onClick={onClose}>
          Exit <kbd>Esc</kbd>
        </button>
      </header>
      <div className="perform-scroll">
        {lines.length === 0 ? (
          <p className="perform-empty">Write some lyrics first. They'll scroll here with the beat.</p>
        ) : (
          <ol className="perform-lines">
            {lines.map((l, i) => {
              const newSection = i === 0 || lines[i - 1].section !== l.section;
              const m = markers[l.section];
              return (
                <li
                  key={l.key}
                  ref={(el) => {
                    if (el) refs.current.set(l.key, el);
                    else refs.current.delete(l.key);
                  }}
                  className={`${i === cur ? "now" : i < cur ? "past" : ""} ${newSection ? "sec-start" : ""}`}
                  onClick={() => onSeek(l.t)}
                >
                  {newSection && <span className="perform-sec">{m.label || `Section ${l.section + 1}`} · {fmt(m.time)}</span>}
                  <span className="perform-text">{l.text}</span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <p className="perform-foot">Space to play/pause · click a line to jump there</p>
    </div>
  );
}

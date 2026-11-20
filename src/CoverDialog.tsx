import { useEffect, useRef, useState } from "react";
import { LyricHit, cleanTitle, linesToMarkers, parseLRC, searchLyrics } from "./lyrics";
import type { Marker } from "./db";
import { fmt } from "./time";

interface Props {
  initialQuery: string;
  videoDuration: number;
  onImport: (markers: Marker[], hit: LyricHit) => void;
  onClose: () => void;
}

export default function CoverDialog({ initialQuery, videoDuration, onImport, onClose }: Props) {
  const [q, setQ] = useState(() => cleanTitle(initialQuery));
  const [hits, setHits] = useState<LyricHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDialogElement>(null);

  const run = async (query: string) => {
    if (!query.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      setHits(await searchLyrics(query));
    } catch {
      setErr("Couldn't reach the lyrics library. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    ref.current?.showModal();
    if (q) run(q);
  }, []);

  return (
    <dialog ref={ref} className="cover-dialog" onClose={onClose} onCancel={onClose}>
      <header>
        <div>
          <h2>Cover / parody</h2>
          <p>Pull a song's lyrics with their timestamps. Each section becomes a marker with the original lines next to yours.</p>
        </div>
        <button className="x" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      <form
        className="cover-search"
        onSubmit={(e) => {
          e.preventDefault();
          run(q);
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Song title and artist" autoFocus aria-label="Song" />
        <button type="submit" disabled={busy}>
          {busy ? "…" : "Search"}
        </button>
      </form>
      {err && <p className="cover-err">{err}</p>}
      <ul className="hits">
        {hits?.length === 0 && <li className="hit-empty">No matches. Try just the song title and the artist.</li>}
        {hits?.map((h) => {
          const close = videoDuration > 0 && Math.abs(h.duration - videoDuration) <= 3;
          return (
            <li key={h.id} className="hit">
              <div className="hit-main">
                <span className="hit-track">{h.track}</span>
                <span className="hit-artist">
                  {h.artist}
                  {h.album ? ` · ${h.album}` : ""}
                </span>
              </div>
              <span className={`hit-len ${close ? "match" : ""}`} title={close ? "Same length as your video, so timing should line up" : undefined}>
                {fmt(h.duration)}
                {close ? " ✓" : ""}
              </span>
              <button
                className="hit-go"
                disabled={!h.synced}
                title={h.synced ? "Import with timestamps" : "This one has no timestamps"}
                onClick={() => h.synced && onImport(linesToMarkers(parseLRC(h.synced)), h)}
              >
                {h.synced ? "Import" : "No timing"}
              </button>
            </li>
          );
        })}
      </ul>
      <footer>
        Lyrics from LRCLIB. If your video has a different intro than the original, nudge the timing after importing.
      </footer>
    </dialog>
  );
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { analyze } from "./rhyme";
import { Switch } from "./ui";
import type { Marker, OrigLine, Take } from "./db";
import type { RecPhase } from "./App";
import { fmt, parseTime } from "./time";
import { useClock } from "./clock";

interface Props {
  marker: Marker;
  index: number;
  nextTime?: number;
  active: boolean;
  takes: Take[];
  rec: RecPhase | null;
  recBusy: boolean;
  playingTakeId: string | null;
  autoFocus: boolean;
  onFocused: () => void;
  onChange: (patch: Partial<Marker>) => void;
  onSeek: (play: boolean) => void;
  onRestamp: () => void;
  onDelete: () => void;
  onRecord: () => void;
  onPlayTake: (t: Take) => void;
  withBeat: boolean;
  onWithBeat: (on: boolean) => void;
  showOriginal: boolean;
  onSeekTo: (t: number) => void;
  onStopTake: () => void;
  onRenameTake: (t: Take, name: string) => void;
  onDeleteTake: (t: Take) => void;
  onStarTake: (t: Take) => void;
  /** The take that "Play song" will use for this section. */
  songTakeId: string | null;
  looping: boolean;
  onLoop: () => void;
  showMeter: boolean;
}

export default function MarkerBlock(p: Props) {
  const { marker, takes } = p;
  const area = useRef<HTMLTextAreaElement>(null);
  const [editingTime, setEditingTime] = useState(false);
  const [timeDraft, setTimeDraft] = useState("");

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "0px";
    const origRows = marker.original && p.showOriginal ? marker.original.length * 32 : 0;
    el.style.height = `${Math.max(el.scrollHeight, 64, origRows)}px`;
  }, [marker.lyrics, p.showOriginal, marker.original?.length]);

  useEffect(() => {
    if (p.autoFocus) {
      area.current?.focus({ preventScroll: false });
      p.onFocused();
    }
  }, [p.autoFocus]);

  const span = p.nextTime !== undefined ? p.nextTime - marker.time : undefined;
  const lines = marker.lyrics.split("\n").filter((l) => l.trim()).length;

  return (
    <article
      id={`m-${marker.id}`}
      className={`block ${p.active ? "active" : ""} ${p.rec ? "recording" : ""} ${p.looping ? "looping" : ""}`}
    >
      <div className="gutter">
        {editingTime ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const t = parseTime(timeDraft);
              if (t !== null) p.onChange({ time: t });
              setEditingTime(false);
            }}
          >
            <input
              className="time-edit"
              autoFocus
              value={timeDraft}
              onChange={(e) => setTimeDraft(e.target.value)}
              onBlur={() => setEditingTime(false)}
              aria-label="Marker time"
            />
          </form>
        ) : (
          <button
            className="stamp-chip"
            onClick={() => p.onSeek(true)}
            onDoubleClick={() => {
              setTimeDraft(fmt(marker.time, true));
              setEditingTime(true);
            }}
            title="Jump the video here and play · double-click to type a time"
          >
            {fmt(marker.time, true)}
          </button>
        )}
        <div className="gutter-tools">
          <button
            onClick={p.onLoop}
            className={p.looping ? "looping" : ""}
            aria-pressed={p.looping}
            title="Repeat this section of the beat so you can practice"
          >
            {p.looping ? "■ looping" : "⟲ loop"}
          </button>
          <button onClick={p.onRestamp} title="Move this marker to where the video is right now (click the time above to jump the video here instead)">
            ⤓ set to now
          </button>
          <button onClick={p.onDelete} title="Delete marker" className="danger">
            delete
          </button>
        </div>
        {span !== undefined && <div className="span">{span.toFixed(1)}s</div>}
      </div>

      <div className="page">
        <input
          className="label"
          value={marker.label}
          onChange={(e) => p.onChange({ label: e.target.value })}
          placeholder={`Section ${p.index + 1} — verse, hook, bridge…`}
          aria-label="Section name"
        />
        {marker.original && p.showOriginal ? (
          <div className="duo">
            <OrigLines lines={marker.original} onSeek={p.onSeekTo} />
            <div className="duo-mine">
              <LyricPad
                areaRef={area}
                value={marker.lyrics}
                onChange={(v) => p.onChange({ lyrics: v })}
                placeholder="Your version, line for line…"
                label={`Lyrics at ${fmt(marker.time)}`}
                showMeter={p.showMeter}
              />
              {!marker.lyrics.trim() && (
                <button
                  className="copy-orig"
                  onClick={() => p.onChange({ lyrics: marker.original!.map((l) => l.text).join("\n") })}
                >
                  Start from the original lines
                </button>
              )}
            </div>
          </div>
        ) : (
          <LyricPad
            areaRef={area}
            value={marker.lyrics}
            onChange={(v) => p.onChange({ lyrics: v })}
            placeholder="Write your bars here…"
            label={`Lyrics at ${fmt(marker.time)}`}
            showMeter={p.showMeter}
          />
        )}
        {lines > 0 && <div className="bar-count">{lines} bar{lines === 1 ? "" : "s"}</div>}

        <div className="flows">
          <button
            className={`rec-btn ${p.rec ?? ""}`}
            onClick={p.onRecord}
            disabled={p.recBusy}
            aria-pressed={!!p.rec}
          >
            <span className="rec-dot" aria-hidden />
            {p.rec === "arming" ? "Cueing beat…" : p.rec === "recording" ? <RecTimer /> : "Record flow"}
          </button>
          {takes.length > 0 && (
            <Switch
              on={p.withBeat}
              onChange={p.onWithBeat}
              label="with beat"
              tone="paper"
              title="Hear the beat under your take (you can flip this while it plays)"
            />
          )}
          <ul className="takes">
            {takes.map((t) => (
              <TakeChip
                key={t.id}
                take={t}
                playing={p.playingTakeId === t.id}
                inSong={p.songTakeId === t.id}
                onStar={() => p.onStarTake(t)}
                onPlay={() => (p.playingTakeId === t.id ? p.onStopTake() : p.onPlayTake(t))}
                onRename={(n) => p.onRenameTake(t, n)}
                onDelete={() => p.onDeleteTake(t)}
              />
            ))}
          </ul>
        </div>
      </div>
    </article>
  );
}

function RecTimer() {
  const [start] = useState(() => performance.now());
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 200);
    return () => clearInterval(t);
  }, []);
  // Show beat time too, so you know where you are in the song.
  const beat = useClock((s) => Math.floor(s.now));
  return (
    <>
      Stop · {fmt((performance.now() - start) / 1000)} <span className="rec-at">@ {fmt(beat)}</span>
    </>
  );
}

function TakeChip({
  take,
  playing,
  onPlay,
  onRename,
  onDelete,
  inSong,
  onStar,
}: {
  take: Take;
  playing: boolean;
  inSong: boolean;
  onStar: () => void;
  onPlay: () => void;
  onRename: (n: string) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(take.name);
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => setName(take.name), [take.name]);
  useEffect(() => {
    const u = URL.createObjectURL(take.blob);
    setHref(u);
    return () => URL.revokeObjectURL(u);
  }, [take.blob]);

  const ext = take.mime.includes("mp4") ? "m4a" : take.mime.includes("ogg") ? "ogg" : "webm";

  return (
    <li className={`take ${playing ? "playing" : ""} ${take.starred ? "starred" : ""}`}>
      <button className="take-play" onClick={onPlay} aria-label={playing ? `Stop ${take.name}` : `Play ${take.name}`}>
        {playing ? "■" : "▶"}
      </button>
      <input
        className="take-name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name !== take.name && onRename(name.trim())}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        aria-label="Take name"
      />
      <button
        className={`take-star ${take.starred ? "on" : ""}`}
        onClick={onStar}
        aria-pressed={!!take.starred}
        aria-label={take.starred ? `Unstar ${take.name}` : `Star ${take.name} as the keeper`}
        title={
          take.starred
            ? "Your keeper for this section"
            : inSong
              ? "Newest take, used in Play song until you star one"
              : "Star as the keeper for Play song"
        }
      >
        {take.starred ? "★" : "☆"}
      </button>
      <span className="take-meta">
        {fmt(take.duration)} @ {fmt(take.start)}
      </span>
      <a
        className="take-dl"
        href={href ?? "#"}
        download={`${name || take.name}.${ext}`}
        title="Download"
      >
        ↓
      </a>
      <button className="take-del" onClick={onDelete} aria-label={`Delete ${take.name}`} title="Delete take">
        ×
      </button>
    </li>
  );
}

/** The original song's lines, one per ruled line, with the line being sung highlighted. */
function OrigLines({ lines, onSeek }: { lines: OrigLine[]; onSeek: (t: number) => void }) {
  const first = lines[0].t;
  const last = lines[lines.length - 1].t + 6;
  const cur = useClock((s) => {
    if (s.now < first - 0.05 || s.now > last) return -1;
    let i = -1;
    for (let k = 0; k < lines.length; k++) if (lines[k].t <= s.now + 0.05) i = k;
    return i;
  });
  return (
    <ol className="orig" aria-label="Original lyrics">
      {lines.map((l, i) => (
        <li key={i} className={i === cur ? "on" : ""}>
          <button onClick={() => onSeek(l.t)} title={`${l.text}\nPlay from ${fmt(l.t, true)}`}>
            <span className="orig-t">{fmt(l.t)}</span>
            <span className="orig-text">{l.text}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

const RHYME_COLORS = 6;

/**
 * Textarea with a highlight layer behind it (rhyming line endings get the same color)
 * and a meter column with syllables and rhyme-scheme letters. Lines don't wrap so
 * everything stays on its ruled line.
 */
function LyricPad({
  areaRef,
  value,
  onChange,
  placeholder,
  label,
  showMeter,
}: {
  areaRef: React.RefObject<HTMLTextAreaElement>;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
  showMeter: boolean;
}) {
  const back = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => value.split("\n"), [value]);
  const info = useMemo(() => analyze(lines), [lines]);

  return (
    <div className={`pad ${showMeter ? "metered" : ""}`}>
      <div className="pad-field">
        {showMeter && (
          <div className="pad-back" ref={back} aria-hidden>
            {lines.map((l, i) => {
              const inf = info[i];
              if (inf.colorIndex < 0) return <div key={i}>{l || "\u00a0"}</div>;
              const m = l.match(/^(.*?)(\S+)(\s*)$/);
              if (!m) return <div key={i}>{l || "\u00a0"}</div>;
              return (
                <div key={i}>
                  {m[1]}
                  <mark className={`rh rh-${inf.colorIndex % RHYME_COLORS}`}>{m[2]}</mark>
                  {m[3]}
                </div>
              );
            })}
          </div>
        )}
        <textarea
          ref={areaRef}
          className="lyrics"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onScroll={(e) => {
            if (back.current) back.current.scrollLeft = (e.target as HTMLTextAreaElement).scrollLeft;
          }}
          placeholder={placeholder}
          wrap="off"
          spellCheck={false}
          aria-label={label}
        />
      </div>
      {showMeter && value.trim() && (
        <ol className="meter" aria-label="Syllables and rhyme scheme">
          {info.map((inf, i) => (
            <li key={i} title={inf.syllables ? `${inf.syllables} syllables${inf.letter ? ` · rhyme ${inf.letter}` : ""}` : undefined}>
              {inf.syllables > 0 && <span className="syl">{inf.syllables}</span>}
              {inf.letter && <span className={`scheme rh-${inf.colorIndex % RHYME_COLORS}`}>{inf.letter}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

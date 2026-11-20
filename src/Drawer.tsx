import { useEffect, useRef, useState } from "react";
import type { Project, Snapshot } from "./db";
import { listSnapshots } from "./db";
import { syllables } from "./rhyme";

export type DrawerTab = "notes" | "rhymes" | "history";

interface Props {
  tab: DrawerTab;
  onTab: (t: DrawerTab) => void;
  onClose: () => void;
  project: Project;
  onNotes: (v: string) => void;
  word: string;
  onWord: (w: string) => void;
  onRestore: (s: Snapshot) => void;
  historyKey: number; // bump to reload the list
  flash: (m: string) => void;
}

export default function Drawer(p: Props) {
  return (
    <aside className="drawer" aria-label="Song tools">
      <header className="drawer-head">
        <div className="drawer-tabs" role="tablist">
          {(
            [
              ["notes", "Notes"],
              ["rhymes", "Rhymes"],
              ["history", "History"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={p.tab === k} className={p.tab === k ? "on" : ""} onClick={() => p.onTab(k)}>
              {label}
            </button>
          ))}
        </div>
        <button className="drawer-x" onClick={p.onClose} aria-label="Close panel">
          ×
        </button>
      </header>
      <div className="drawer-body">
        {p.tab === "notes" && <Notes value={p.project.notes ?? ""} onChange={p.onNotes} />}
        {p.tab === "rhymes" && <Rhymes word={p.word} onWord={p.onWord} flash={p.flash} />}
        {p.tab === "history" && <History projectId={p.project.id} reloadKey={p.historyKey} onRestore={p.onRestore} />}
      </div>
    </aside>
  );
}

function Notes({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="notes">
      <p className="drawer-hint">Ideas, hooks you haven't placed yet, references. Saved with this song.</p>
      <textarea
        className="notes-area"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={"hook idea: …\nwords to use: …\nref: …"}
        spellCheck={false}
      />
    </div>
  );
}

/* ---------------- Rhymes (Datamuse, free, no key) ---------------- */
interface Hit {
  word: string;
  numSyllables?: number;
  score?: number;
}

function Rhymes({ word, onWord, flash }: { word: string; onWord: (w: string) => void; flash: (m: string) => void }) {
  const [draft, setDraft] = useState(word);
  const [perfect, setPerfect] = useState<Hit[] | null>(null);
  const [near, setNear] = useState<Hit[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(word), [word]);

  useEffect(() => {
    const w = word.trim().toLowerCase();
    if (!w) {
      setPerfect(null);
      setNear(null);
      return;
    }
    let live = true;
    setBusy(true);
    setErr(null);
    const q = encodeURIComponent(w);
    Promise.all([
      fetch(`https://api.datamuse.com/words?rel_rhy=${q}&md=s&max=80`).then((r) => r.json()),
      fetch(`https://api.datamuse.com/words?rel_nry=${q}&md=s&max=60`).then((r) => r.json()),
    ])
      .then(([a, b]) => {
        if (!live) return;
        setPerfect(a);
        setNear(b);
      })
      .catch(() => live && setErr("Couldn't reach the rhyme dictionary. Check your connection."))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [word]);

  const copy = async (w: string) => {
    try {
      await navigator.clipboard.writeText(w);
      flash(`Copied "${w}"`);
    } catch {
      flash(w);
    }
  };

  const group = (hits: Hit[]) => {
    const by = new Map<number, Hit[]>();
    for (const h of hits) {
      const n = h.numSyllables ?? syllables(h.word);
      if (!by.has(n)) by.set(n, []);
      by.get(n)!.push(h);
    }
    return [...by.entries()].sort((a, b) => a[0] - b[0]);
  };

  return (
    <div className="rhymes">
      <form
        className="rhyme-search"
        onSubmit={(e) => {
          e.preventDefault();
          onWord(draft.trim());
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type a word, or select one in your lyrics" aria-label="Word to rhyme" />
        <button type="submit">Find</button>
      </form>
      {!word && <p className="drawer-hint">Tip: highlight a word in your lyrics and it shows up here.</p>}
      {busy && <p className="drawer-hint">Looking…</p>}
      {err && <p className="drawer-err">{err}</p>}
      {word && perfect && !busy && (
        <>
          <h4>
            Rhymes with <b>{word}</b>
          </h4>
          {perfect.length === 0 && <p className="drawer-hint">No perfect rhymes. Try the near ones below.</p>}
          {group(perfect).map(([n, hs]) => (
            <div key={n} className="rhyme-group">
              <span className="rhyme-syl">{n} syl</span>
              <div className="chips">
                {hs.map((h) => (
                  <button key={h.word} className="chip" onClick={() => copy(h.word)} title="Copy">
                    {h.word}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {near && near.length > 0 && (
            <>
              <h4>Near rhymes</h4>
              <div className="chips">
                {near.map((h) => (
                  <button key={h.word} className="chip near" onClick={() => copy(h.word)} title="Copy">
                    {h.word}
                  </button>
                ))}
              </div>
            </>
          )}
          <p className="drawer-hint small">Tap a word to copy it. Rhymes from Datamuse.</p>
        </>
      )}
    </div>
  );
}

/* ---------------- History ---------------- */
function History({ projectId, reloadKey, onRestore }: { projectId: string; reloadKey: number; onRestore: (s: Snapshot) => void }) {
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const first = useRef(true);
  useEffect(() => {
    let live = true;
    listSnapshots(projectId).then((s) => live && setSnaps(s));
    first.current = false;
    return () => {
      live = false;
    };
  }, [projectId, reloadKey]);

  if (!snaps) return <p className="drawer-hint">Loading…</p>;
  if (!snaps.length)
    return <p className="drawer-hint">No saved versions yet. Inkbeat saves a version of your lyrics every half minute or so while you write.</p>;

  const fmtWhen = (t: number) => {
    const d = new Date(t);
    const today = new Date();
    const same = d.toDateString() === today.toDateString();
    return (same ? "Today " : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " ") + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  };

  return (
    <div className="history">
      <p className="drawer-hint">Older versions of this song's lyrics. Restoring saves your current version first, so you can always go back.</p>
      <ol className="snaps">
        {snaps.map((s) => {
          const lines = s.markers.flatMap((m) => m.lyrics.split("\n")).filter((l) => l.trim());
          return (
            <li key={s.id} className={open === s.id ? "open" : ""}>
              <button className="snap-head" onClick={() => setOpen(open === s.id ? null : s.id)}>
                <span className="snap-when">{fmtWhen(s.at)}</span>
                <span className="snap-meta">
                  {lines.length} line{lines.length === 1 ? "" : "s"} · {s.markers.length} section{s.markers.length === 1 ? "" : "s"}
                </span>
                <span className="snap-first">{lines[0] ?? "(empty)"}</span>
              </button>
              {open === s.id && (
                <div className="snap-body">
                  {s.markers
                    .filter((m) => m.lyrics.trim())
                    .map((m) => (
                      <div key={m.id} className="snap-sec">
                        {m.label && <b>{m.label}</b>}
                        <pre>{m.lyrics}</pre>
                      </div>
                    ))}
                  <button className="snap-restore" onClick={() => onRestore(s)}>
                    Restore this version
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

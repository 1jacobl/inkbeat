export interface OrigLine {
  t: number; // seconds into the video
  text: string;
}

export interface Marker {
  id: string;
  time: number; // seconds into the beat
  label: string; // e.g. "Verse 1", "Hook"
  lyrics: string;
  /** Cover / parody mode: the original song's lines for this section. */
  original?: OrigLine[];
}

export interface Project {
  id: string;
  title: string;
  url: string;
  videoId: string;
  markers: Marker[];
  /** Set when lyrics were imported for a cover or parody. */
  cover?: { track: string; artist: string; showOriginal: boolean };
  /** Optional second video (e.g. a karaoke / instrumental version) on the same timeline, shifted by offset seconds. */
  backing?: { videoId: string; url: string; offset: number };
  /** Which video plays: the main one or the backing track. */
  source?: "main" | "backing";
  /** Beat grid for the metronome, bar lines and snapping. */
  tempo?: { bpm: number; downbeat: number; beatsPerBar: number; source?: "auto" | "manual" };
  /** Song key; auto = found by the app, manual = set by you. */
  key?: { tonic: number; mode: "major" | "minor"; source: "auto" | "manual" };
  autoKey?: { tonic: number; mode: "major" | "minor"; from: "video name" | "audio" } | null;
  /** What the automatic lookup found (null = looked, found nothing; undefined = not looked yet). */
  autoBpm?: { bpm: number; from: "video name" | "description" | "song database" | "audio"; downbeat?: number } | null;
  /** Your own beat file (audio stored in its own database). Used instead of a YouTube link. */
  beat?: { name: string; duration: number; size: number };
  /** Free-form scratchpad for ideas, unused bars, references. */
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Take {
  id: string;
  projectId: string;
  markerId: string;
  name: string;
  /** Beat time (seconds) at the instant the recording started. */
  start: number;
  duration: number;
  mime: string;
  blob: Blob;
  createdAt: number;
  /** The keeper for its section; used by "Play song". */
  starred?: boolean;
  /** Recorded over another take (ad-libs, doubles): plays along with that take. */
  layerOf?: string;
  /** Sound settings for this take. */
  fx?: TakeFx;
}

export interface TakeFx {
  gain: number; // dB, -24..+12
  low: number; // bass shelf dB
  high: number; // treble shelf dB
  reverb: number; // 0..1 wet
}
export const NO_FX: TakeFx = { gain: 0, low: 0, high: 0, reverb: 0 };

const DB_NAME = "inkbeat";
// No version number: open whatever version exists. Upgrading the main database can get stuck
// in Chrome (another tab holds it), so new storage goes in separate databases instead.
const HISTORY_DB = "inkbeat-history";
let dbPromise: Promise<IDBDatabase> | null = null;

/** Set when another open Inkbeat tab is holding up a storage upgrade. */
export let onStorageBlocked: (() => void) | null = null;
export function setStorageBlockedHandler(fn: (() => void) | null) {
  onStorageBlocked = fn;
}

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no-indexeddb"));
    const req = indexedDB.open(DB_NAME);
    // Only runs the very first time (brand-new database).
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("takes")) {
        const s = db.createObjectStore("takes", { keyPath: "id" });
        s.createIndex("projectId", "projectId");
      }
    };
    // Another tab still has the old version open: tell the user instead of hanging.
    req.onblocked = () => onStorageBlocked?.();
    req.onsuccess = () => {
      const db = req.result;
      // If a newer version of Inkbeat opens in another tab, step aside so it can upgrade.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let historyPromise: Promise<IDBDatabase> | null = null;
function openHistory(): Promise<IDBDatabase> {
  if (historyPromise) return historyPromise;
  historyPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(HISTORY_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("history")) db.createObjectStore("history", { keyPath: "id" }).createIndex("projectId", "projectId");
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        historyPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      historyPromise = null;
      reject(req.error);
    };
  });
  return historyPromise;
}

async function store(name: "projects" | "takes" | "history", mode: IDBTransactionMode) {
  if (name === "history") return (await openHistory()).transaction("history", mode).objectStore("history");
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export async function listProjects(): Promise<Project[]> {
  const all = await wrap((await store("projects", "readonly")).getAll() as IDBRequest<Project[]>);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveProject(p: Project): Promise<void> {
  await wrap((await store("projects", "readwrite")).put(p));
}

export async function deleteProject(id: string): Promise<void> {
  const takes = await listTakes(id);
  const s = await store("takes", "readwrite");
  await Promise.all(takes.map((t) => wrap(s.delete(t.id))));
  await wrap((await store("projects", "readwrite")).delete(id));
  await deleteSnapshotsFor(id).catch(() => {});
  await deleteBeat(id).catch(() => {});
}

export async function listTakes(projectId: string): Promise<Take[]> {
  const s = await store("takes", "readonly");
  const all = await wrap(s.index("projectId").getAll(projectId) as IDBRequest<Take[]>);
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function saveTake(t: Take): Promise<void> {
  await wrap((await store("takes", "readwrite")).put(t));
}

export async function deleteTake(id: string): Promise<void> {
  await wrap((await store("takes", "readwrite")).delete(id));
}

export async function deleteTakesForMarker(projectId: string, markerId: string): Promise<void> {
  const takes = (await listTakes(projectId)).filter((t) => t.markerId === markerId);
  const s = await store("takes", "readwrite");
  await Promise.all(takes.map((t) => wrap(s.delete(t.id))));
}

/* ---------- lyric history ---------- */
export interface Snapshot {
  id: string;
  projectId: string;
  at: number;
  markers: { id: string; time: number; label: string; lyrics: string; original?: Marker["original"] }[];
  notes: string;
}

const KEEP = 80;

export async function listSnapshots(projectId: string): Promise<Snapshot[]> {
  const s = await store("history", "readonly");
  const all = await wrap(s.index("projectId").getAll(projectId) as IDBRequest<Snapshot[]>);
  return all.sort((a, b) => b.at - a.at);
}

export async function saveSnapshot(snap: Snapshot): Promise<void> {
  await wrap((await store("history", "readwrite")).put(snap));
  const all = await listSnapshots(snap.projectId);
  if (all.length > KEEP) {
    const s = await store("history", "readwrite");
    await Promise.all(all.slice(KEEP).map((x) => wrap(s.delete(x.id))));
  }
}

export async function deleteSnapshotsFor(projectId: string): Promise<void> {
  const all = await listSnapshots(projectId);
  const s = await store("history", "readwrite");
  await Promise.all(all.map((x) => wrap(s.delete(x.id))));
}

/* ---------- beat files (own database so the main one never needs an upgrade) ---------- */
export interface BeatFile {
  projectId: string;
  name: string;
  mime: string;
  blob: Blob;
}
const BEATS_DB = "inkbeat-beats";
let beatsPromise: Promise<IDBDatabase> | null = null;
function openBeats(): Promise<IDBDatabase> {
  if (beatsPromise) return beatsPromise;
  beatsPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(BEATS_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("beats")) db.createObjectStore("beats", { keyPath: "projectId" });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        beatsPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      beatsPromise = null;
      reject(req.error);
    };
  });
  return beatsPromise;
}
async function beatStore(mode: IDBTransactionMode) {
  return (await openBeats()).transaction("beats", mode).objectStore("beats");
}
export async function getBeat(projectId: string): Promise<BeatFile | null> {
  return (await wrap((await beatStore("readonly")).get(projectId) as IDBRequest<BeatFile | undefined>)) ?? null;
}
export async function saveBeat(b: BeatFile): Promise<void> {
  await wrap((await beatStore("readwrite")).put(b));
}
export async function deleteBeat(projectId: string): Promise<void> {
  await wrap((await beatStore("readwrite")).delete(projectId));
}

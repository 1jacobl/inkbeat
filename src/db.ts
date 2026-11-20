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
}

const DB_NAME = "inkbeat";
const DB_VERSION = 1;
let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("takes")) {
        const s = db.createObjectStore("takes", { keyPath: "id" });
        s.createIndex("projectId", "projectId");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: "projects" | "takes", mode: IDBTransactionMode) {
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

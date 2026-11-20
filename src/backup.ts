/* Backup files: songs + lyrics + recorded takes in one .json you can move between browsers/devices. */
import { Project, Take, getBeat, listTakes, saveBeat, saveProject, saveTake } from "./db";
import { fmt, uid } from "./time";

const FORMAT = "inkbeat-backup";
const VERSION = 1;

interface TakeFile extends Omit<Take, "blob"> {
  audio: string; // base64
}
interface BackupFile {
  format: typeof FORMAT;
  version: number;
  exportedAt: string;
  projects: Project[];
  takes: TakeFile[];
  beats?: { projectId: string; name: string; mime: string; audio: string }[];
}

function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "song";
}

function download(name: string, data: Blob) {
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function exportBackup(projects: Project[]): Promise<void> {
  const takes: TakeFile[] = [];
  for (const p of projects) {
    for (const t of await listTakes(p.id)) {
      const { blob, ...rest } = t;
      takes.push({ ...rest, audio: await blobToBase64(blob) });
    }
  }
  const beats: NonNullable<BackupFile["beats"]> = [];
  for (const p of projects) {
    if (!p.beat) continue;
    const b = await getBeat(p.id).catch(() => null);
    if (b) beats.push({ projectId: p.id, name: b.name, mime: b.mime, audio: await blobToBase64(b.blob) });
  }
  const file: BackupFile = { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), projects, takes, beats };
  const date = new Date().toISOString().slice(0, 10);
  const name = projects.length === 1 ? `${slug(projects[0].title)}.inkbeat.json` : `inkbeat-backup-${date}.json`;
  download(name, new Blob([JSON.stringify(file)], { type: "application/json" }));
}

/**
 * Adds the songs in a backup file. Nothing existing is overwritten: a song that's already
 * here is imported as a copy.
 */
export async function importBackup(file: File, existingIds: Set<string>): Promise<{ projects: Project[]; takes: number }> {
  let data: BackupFile;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error("That file isn't an Inkbeat backup.");
  }
  if (data?.format !== FORMAT || !Array.isArray(data.projects)) throw new Error("That file isn't an Inkbeat backup.");

  const added: Project[] = [];
  let takeCount = 0;
  for (const p of data.projects) {
    const clash = existingIds.has(p.id);
    const id = clash ? uid() : p.id;
    const project: Project = {
      ...p,
      id,
      title: clash ? `${p.title} (imported)` : p.title,
      markers: Array.isArray(p.markers) ? p.markers : [],
      updatedAt: Date.now(),
    };
    await saveProject(project);
    added.push(project);
    const idMap = new Map<string, string>();
    const mine = data.takes.filter((x) => x.projectId === p.id);
    for (const t of mine) idMap.set(t.id, clash ? uid() : t.id);
    for (const t of mine) {
      const { audio, ...rest } = t;
      await saveTake({
        ...rest,
        id: idMap.get(t.id)!,
        projectId: id,
        ...(t.layerOf ? { layerOf: idMap.get(t.layerOf) ?? t.layerOf } : {}),
        blob: base64ToBlob(audio, t.mime || "audio/webm"),
      });
      takeCount++;
    }
    const beat = data.beats?.find((b) => b.projectId === p.id);
    if (beat) await saveBeat({ projectId: id, name: beat.name, mime: beat.mime, blob: base64ToBlob(beat.audio, beat.mime || "audio/mpeg") });
  }
  return { projects: added, takes: takeCount };
}

/** Plain-text lyric sheet with timestamps and section names. */
export function exportLyricsText(p: Project): void {
  const out: string[] = [p.title, ""];
  for (const m of p.markers) {
    out.push(`[${fmt(m.time)}]${m.label ? ` ${m.label}` : ""}`);
    const body = m.lyrics.trim();
    out.push(body || "(no lyrics yet)", "");
  }
  download(`${slug(p.title)}-lyrics.txt`, new Blob([out.join("\n")], { type: "text/plain" }));
}

/* ---------------- Song codes: copy/paste text instead of files (no recordings) ---------------- */
const CODE_PREFIX = "INKBEAT1:";

function toB64Url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64Url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const res = new Response(new Blob([data]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

/** A pasteable code for songs: lyrics, sections, timing, tempo/key, video links. No audio. */
export async function songCode(projects: Project[]): Promise<string> {
  const slim = projects.map(({ id, title, url, videoId, markers, cover, backing, source, tempo, notes, ...rest }) => ({
    id, title, url, videoId, markers, cover, backing, source, tempo, notes,
    key: (rest as any).key,
  }));
  const json = new TextEncoder().encode(JSON.stringify({ v: 1, projects: slim }));
  const packed = typeof CompressionStream !== "undefined" ? await pipe(json, new CompressionStream("gzip")) : json;
  return CODE_PREFIX + (typeof CompressionStream !== "undefined" ? "z" : "j") + toB64Url(packed);
}

/** Adds the songs in a code. Existing songs are never overwritten (a clash comes in as a copy). */
export async function importSongCode(code: string, existingIds: Set<string>): Promise<Project[]> {
  let t = code.trim().replace(/\s+/g, "");
  // A share link works too.
  const hash = t.indexOf("#s=");
  if (hash >= 0) t = CODE_PREFIX + t.slice(hash + 3);
  if (!t.startsWith(CODE_PREFIX)) throw new Error("That doesn't look like an Inkbeat code.");
  const kind = t[CODE_PREFIX.length];
  let bytes = fromB64Url(t.slice(CODE_PREFIX.length + 1));
  if (kind === "z") bytes = await pipe(bytes, new DecompressionStream("gzip"));
  let data: any;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("That code is incomplete. Copy the whole thing and try again.");
  }
  const added: Project[] = [];
  for (const p of data.projects ?? []) {
    const clash = existingIds.has(p.id);
    const now = Date.now();
    const project: Project = {
      ...p,
      id: clash ? uid() : p.id,
      title: clash ? `${p.title} (pasted)` : p.title,
      markers: Array.isArray(p.markers) ? p.markers : [],
      beat: undefined,
      createdAt: now,
      updatedAt: now,
    };
    await saveProject(project);
    added.push(project);
  }
  return added;
}

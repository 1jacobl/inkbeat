/* Cover / parody mode: look up time-synced lyrics on LRCLIB (free, no key) and turn them into markers. */
import type { Marker, OrigLine } from "./db";
import { uid } from "./time";

export interface LyricHit {
  id: number;
  track: string;
  artist: string;
  album: string;
  duration: number;
  synced: string | null;
  plain: string | null;
}

export async function searchLyrics(q: string): Promise<LyricHit[]> {
  const r = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error(`Lyrics search failed (${r.status})`);
  const rows: any[] = await r.json();
  const hits = rows.map((x) => ({
    id: x.id,
    track: x.trackName,
    artist: x.artistName,
    album: x.albumName,
    duration: x.duration,
    synced: x.syncedLyrics || null,
    plain: x.plainLyrics || null,
  }));
  // Timed results first.
  return hits.sort((a, b) => Number(!!b.synced) - Number(!!a.synced));
}

/** Strips YouTube-title noise so the search box starts with something useful. */
export function cleanTitle(title: string): string {
  return title
    .replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】/g, " ")
    .replace(/\b(official|music|lyric|lyrics|video|audio|visualizer|hd|4k|mv|instrumental|karaoke|remaster(ed)?)\b/gi, " ")
    .replace(/\s*[|•·].*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseLRC(lrc: string): OrigLine[] {
  const out: OrigLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const s of stamps) out.push({ t: +s[1] * 60 + parseFloat(s[2]), text });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Groups timed lines into sections: a new section starts after an instrumental gap,
 * a blank line, or every 8 lines.
 */
export function linesToMarkers(lines: OrigLine[], offset = 0): Marker[] {
  const markers: Marker[] = [];
  let cur: OrigLine[] = [];
  let prevT = -Infinity;
  const flush = () => {
    if (!cur.length) return;
    markers.push({
      id: uid(),
      time: Math.max(0, Math.round((cur[0].t + offset) * 100) / 100),
      label: "",
      lyrics: "",
      original: cur.map((l) => ({ t: Math.max(0, l.t + offset), text: l.text })),
    });
    cur = [];
  };
  for (const l of lines) {
    if (!l.text) {
      flush();
      prevT = l.t;
      continue;
    }
    if (cur.length >= 8 || (cur.length && l.t - prevT > 6)) flush();
    cur.push(l);
    prevT = l.t;
  }
  flush();
  return markers;
}

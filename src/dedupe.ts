/* Matching and cleaning up sections that are really the same part of the song. */
import type { Marker } from "./db";

const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9'\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1)
  );

/** 0..1: how much two sections' original (imported) lines overlap. */
export function originalOverlap(a: Marker, b: Marker): number {
  if (!a.original?.length || !b.original?.length) return 0;
  const A = words(a.original.map((l) => l.text).join(" "));
  const B = words(b.original.map((l) => l.text).join(" "));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  A.forEach((w) => B.has(w) && shared++);
  return shared / Math.min(A.size, B.size);
}

/**
 * Pairs each new imported section with the old one it replaces, by lyric overlap first and time second.
 * Returns a map from index in `fresh` to the old marker.
 */
export function pairSections(old: Marker[], fresh: Marker[], priority: (m: Marker) => number): Map<number, Marker> {
  const cands: { o: Marker; i: number; score: number }[] = [];
  for (const o of old)
    fresh.forEach((n, i) => {
      const text = originalOverlap(o, n);
      const dt = Math.abs(o.time - n.time);
      const timeScore = dt <= 4 ? 1 - dt / 4 : 0;
      if (text < 0.5 && timeScore === 0) return;
      cands.push({ o, i, score: text * 2 + timeScore + priority(o) * 0.01 });
    });
  cands.sort((a, b) => b.score - a.score);
  const usedOld = new Set<string>();
  const claim = new Map<number, Marker>();
  for (const c of cands) {
    if (usedOld.has(c.o.id) || claim.has(c.i)) continue;
    usedOld.add(c.o.id);
    claim.set(c.i, c.o);
  }
  return claim;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Groups of sections that are duplicates of each other: same spot (within 0.6s, or same
 * imported lines within 15s) and not holding different words. First item is the one to keep.
 */
export function findDuplicates(markers: Marker[], takeCount: (id: string) => number): Marker[][] {
  const sorted = [...markers].sort((a, b) => a.time - b.time);
  const seen = new Set<string>();
  const groups: Marker[][] = [];
  for (const a of sorted) {
    if (seen.has(a.id)) continue;
    const g = [a];
    for (const b of sorted) {
      if (b === a || seen.has(b.id)) continue;
      const near = Math.abs(a.time - b.time) <= 0.6;
      const sameOriginal = Math.abs(a.time - b.time) <= 15 && originalOverlap(a, b) >= 0.8;
      if (!near && !sameOriginal) continue;
      const la = norm(g.find((x) => x.lyrics.trim())?.lyrics ?? "");
      const lb = norm(b.lyrics);
      if (la && lb && la !== lb) continue; // different words: keep both
      g.push(b);
    }
    if (g.length > 1) {
      // Keep the one with the most stuff: your words, takes, a label, then imported lines.
      const score = (m: Marker) => (m.lyrics.trim() ? 4 : 0) + Math.min(3, takeCount(m.id)) + (m.label ? 1 : 0) + (m.original ? 0.5 : 0);
      g.sort((x, y) => score(y) - score(x));
      g.forEach((m) => seen.add(m.id));
      groups.push(g);
    }
  }
  return groups;
}

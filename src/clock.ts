import { useSyncExternalStore } from "react";
import type { YTPlayer } from "./youtube";

/**
 * Polls the YouTube player and smooths its coarse getCurrentTime() into a
 * continuous estimate, so recordings and markers line up with the beat.
 */
let player: YTPlayer | null = null;
let reported = 0; // last value the player reported
let reportedAt = 0; // performance.now() when that value first appeared
let playing = false;
let duration = 0;
let snapshotNow = 0;
/** Song time = player time − offset. Lets a karaoke version with a longer intro share the song's timeline. */
let offset = 0;
const listeners = new Set<() => void>();

function tick() {
  if (!player) return;
  try {
    const t = player.getCurrentTime() || 0;
    const p = player.getPlayerState() === 1;
    const d = player.getDuration() || 0;
    const perf = performance.now();
    if (t !== reported || p !== playing) {
      reported = t;
      reportedAt = perf;
    }
    playing = p;
    duration = Math.max(0, d - offset);
    const est = estimateNow();
    if (Math.abs(est - snapshotNow) > 0.04 || !p) snapshotNow = est;
    listeners.forEach((l) => l());
  } catch {
    /* player not ready yet */
  }
}
setInterval(tick, 20);

export function attachPlayer(p: YTPlayer | null) {
  player = p;
  reported = 0;
  reportedAt = performance.now();
  playing = false;
  duration = 0;
  snapshotNow = 0;
  listeners.forEach((l) => l());
}

/** Best estimate of the beat's current time, in seconds. */
export function estimateNow(): number {
  if (!playing) return reported - offset;
  const drift = (performance.now() - reportedAt) / 1000;
  // The player reports roughly every 100–250ms; never extrapolate further than that.
  return reported + Math.min(drift, 0.5) - offset;
}

export function setOffset(o: number) {
  offset = o;
  snapshotNow = estimateNow();
}

export function getOffset() {
  return offset;
}

export function isPlaying() {
  return playing;
}

/** Call right after seekTo so estimates don't extrapolate from the old position. */
export function noteSeek(t: number) {
  reported = t + offset;
  reportedAt = performance.now();
  snapshotNow = t;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Subscribe to a primitive derived from the clock. Only re-renders when it changes. */
export function useClock<T extends string | number | boolean>(
  select: (s: { now: number; playing: boolean; duration: number }) => T
): T {
  return useSyncExternalStore(subscribe, () => select({ now: snapshotNow, playing, duration }));
}

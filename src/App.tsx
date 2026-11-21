import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Marker,
  Project,
  Take,
  deleteProject,
  deleteTake,
  deleteTakesForMarker,
  listProjects,
  listTakes,
  saveProject,
  saveTake,
  TakeFx,
  getBeat,
  saveBeat,
  deleteBeat,
} from "./db";
import { BEAT_TYPES, FilePlayer, analyzeBeat, decodeFile, peaks, titleFromFile } from "./beatfile";
import { routeAudio } from "./fx";
import PitchLine from "./Pitch";
import { YTPlayer, loadYouTubeAPI, parseStartParam, parseVideoId } from "./youtube";
import { attachPlayer, estimateNow, getOffset, isPlaying, noteSeek, setOffset, useClock } from "./clock";
import { KeyPicker, Segmented, Stepper, Switch } from "./ui";
import { keyInText, keyName, relative, scaleNotes } from "./key";
import logo from "./logo.svg";
import { marquee } from "./marquee";
import Home from "./Home";
import Perform from "./Perform";
import Drawer, { DrawerTab } from "./Drawer";
import { Snapshot, listSnapshots, saveSnapshot, setStorageBlockedHandler } from "./db";
import { mixTakes, splicePunch } from "./audio";
import { captureTabAudio, detectFromStream, findBpm } from "./bpm";
import { bpmFromTitle, countIn, makeTapper, metronome, snapToBeat } from "./metronome";
import { exportBackup, exportLyricsText, importBackup, importSongCode, songCode } from "./backup";
import { fmt, parseTime, uid } from "./time";
import Timeline, { Wave } from "./Timeline";
import MarkerBlock from "./MarkerBlock";
import CoverDialog from "./CoverDialog";
import { findDuplicates, pairSections } from "./dedupe";
import type { LyricHit } from "./lyrics";

const LAST_KEY = "inkbeat:last";
const PREFS_KEY = "inkbeat:prefs";

interface Prefs {
  leadIn: number; // seconds of beat before the marker when recording
  nudgeMs: number; // shifts takes against the beat on playback
  follow: boolean; // auto-scroll the sheet to the active marker
  showMeter: boolean; // syllable counts + rhyme colors
  splash: boolean; // startup animation when the site opens
  metronome: boolean; // click track while the beat plays (needs a BPM)
  countIn: boolean; // four clicks before recording starts
  snap: boolean; // markers snap to the nearest beat
  pitch: boolean; // live pitch line while recording
}

function loadPrefs(): Prefs {
  const d: Prefs = { leadIn: 0, nudgeMs: 0, follow: true, showMeter: true, splash: true, metronome: false, countIn: true, snap: false, pitch: true };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") };
  } catch {
    return d;
  }
}

/** True when the song has something to play: a YouTube link or an uploaded beat file. */
export function hasBeat(p: Project | null | undefined): boolean {
  return !!(p && (p.videoId || p.beat));
}

function newProject(): Project {
  const now = Date.now();
  return { id: uid(), title: "Untitled song", url: "", videoId: "", markers: [], createdAt: now, updatedAt: now };
}

export type RecPhase = "arming" | "recording";
export interface RecState {
  markerId: string;
  phase: RecPhase;
}

function pickMime(): string {
  const options = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  for (const m of options) if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  return "";
}

// Shared so React's dev double-mount doesn't create two starter songs.
let initialLoad: Promise<Project[]> | null = null;
function initialProjects(): Promise<Project[]> {
  initialLoad ??= (async () => {
    const ps = await listProjects();
    if (ps.length) return ps;
    const p = newProject();
    await saveProject(p);
    return [p];
  })();
  return initialLoad;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [takes, setTakes] = useState<Take[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [rec, setRec] = useState<RecState | null>(null);
  const [playingTakeId, setPlayingTakeId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const [linkDraft, setLinkDraft] = useState("");
  const [stampDraft, setStampDraft] = useState("");
  const [focusMarkerId, setFocusMarkerId] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [coverOpen, setCoverOpen] = useState(false);
  const [view, setViewState] = useState<"home" | "song">(() => (window.location.hash === "#home" ? "home" : "song"));
  const setView = useCallback((v: "home" | "song") => {
    setViewState(v);
    const want = v === "home" ? "#home" : "";
    if (window.location.hash !== want) {
      if (v === "home") window.location.hash = "home";
      else history.pushState(null, "", window.location.pathname + window.location.search);
    }
  }, []);
  useEffect(() => {
    const onHash = () => setViewState(window.location.hash === "#home" ? "home" : "song");
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onHash);
    };
  }, []);

  const playerRef = useRef<YTPlayer | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const savedRef = useRef(new Map<string, Project>());
  const saveTimers = useRef(new Map<string, number>());
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<{ recorder: MediaRecorder; t0: number; startBeat: number; markerId: string } | null>(null);
  const audioRef = useRef<{ audio: HTMLAudioElement; url: string; takeId: string } | null>(null);
  const recTokenRef = useRef(0);
  const playTokenRef = useRef(0);

  const project = projects.find((p) => p.id === currentId) || null;
  const markers = project?.markers ?? [];

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout((flash as any)._t);
    (flash as any)._t = window.setTimeout(() => setToast(null), 3200);
  }, []);

  /* ---------- load + persist ---------- */
  const [bootIssue, setBootIssue] = useState<null | "blocked" | "slow" | "error">(null);
  useEffect(() => {
    setStorageBlockedHandler(() => setBootIssue("blocked"));
    const slow = window.setTimeout(() => setBootIssue((b) => b ?? "slow"), 6000);
    (async () => {
      let ps: Project[];
      try {
        ps = await initialProjects();
      } catch {
        initialLoad = null;
        setBootIssue("error");
        return;
      } finally {
        window.clearTimeout(slow);
      }
      setBootIssue(null);
      ps.forEach((p) => savedRef.current.set(p.id, p));
      setProjects(ps);
      const last = localStorage.getItem(LAST_KEY);
      setCurrentId(ps.find((p) => p.id === last)?.id ?? ps[0].id);
      if (!ps.some((p) => hasBeat(p) || p.markers.length)) setViewState("home");
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    for (const p of projects) {
      if (savedRef.current.get(p.id) === p) continue;
      window.clearTimeout(saveTimers.current.get(p.id));
      saveTimers.current.set(
        p.id,
        window.setTimeout(() => {
          savedRef.current.set(p.id, p);
          saveProject(p);
        }, 350)
      );
    }
  }, [projects]);

  // Flush pending saves if the tab closes mid-typing.
  useEffect(() => {
    const flush = () => {
      for (const p of projectsRef.current) if (savedRef.current.get(p.id) !== p) saveProject(p);
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {}
  }, [prefs]);

  useEffect(() => {
    if (!currentId) return;
    try {
      localStorage.setItem(LAST_KEY, currentId);
    } catch {}
    let live = true;
    listTakes(currentId).then((t) => live && setTakes(t));
    return () => {
      live = false;
    };
  }, [currentId]);

  const update = useCallback((id: string, fn: (p: Project) => Project) => {
    setProjects((ps) => ps.map((p) => (p.id === id ? { ...fn(p), updatedAt: Date.now() } : p)));
  }, []);

  /* ---------- player ---------- */
  const usingBacking = !!(project?.backing && project.source === "backing");
  const fileKey = !usingBacking && project?.beat ? `file:${project.id}:${project.beat.size}:${project.beat.name}` : "";
  const videoId = fileKey || (usingBacking ? project!.backing!.videoId : project?.videoId) || "";
  const [beatPeaks, setBeatPeaks] = useState<Float32Array | null>(null);
  const timeOffset = usingBacking ? project!.backing!.offset : 0;
  const offsetRef = useRef(timeOffset);
  offsetRef.current = timeOffset;
  useEffect(() => {
    if (ready) setOffset(timeOffset);
  }, [timeOffset, ready]);
  // When switching between the original and the karaoke video, pick up at the same spot in the song.
  const resumeRef = useRef<{ t: number; play: boolean; project: string } | null>(null);
  useEffect(() => {
    if (!videoId) {
      // No beat on this song: unload the last song's player so Play/Space/M can't drive it.
      try {
        playerRef.current?.destroy();
      } catch {}
      playerRef.current = null;
      attachPlayer(null);
      setReady(false);
      if (hostRef.current) hostRef.current.innerHTML = "";
      return;
    }
    let cancelled = false;
    setPlayerError(null);
    resumeRef.current =
      playerRef.current && currentIdRef.current === lastPlayerProjectRef.current
        ? { t: estimateNow(), play: isPlaying(), project: currentIdRef.current || "" }
        : null;
    lastPlayerProjectRef.current = currentIdRef.current;
    setBeatPeaks(null);
    if (videoId.startsWith("file:")) {
      const projectId = videoId.split(":")[1];
      try {
        playerRef.current?.destroy();
      } catch {}
      playerRef.current = null;
      attachPlayer(null);
      setReady(false);
      if (hostRef.current) hostRef.current.innerHTML = "";
      (async () => {
        const b = await getBeat(projectId).catch(() => null);
        if (cancelled) return;
        if (!b) return setPlayerError("The beat file for this song is missing on this device. Upload it again.");
        const fp = new FilePlayer(b.blob, b.name);
        try {
          await fp.ready();
        } catch {
          fp.destroy();
          return !cancelled && setPlayerError("Couldn't read that audio file. Try an MP3 or WAV.");
        }
        if (cancelled) return fp.destroy();
        playerRef.current = fp;
        attachPlayer(fp);
        setOffset(0);
        if (import.meta.env.DEV) (window as any).__player = fp;
        setReady(true);
        const r = resumeRef.current;
        resumeRef.current = null;
        if (r && r.t > 0.5) {
          fp.seekTo(r.t);
          noteSeek(r.t);
          if (r.play) fp.playVideo();
        }
        decodeFile(b.blob)
          .then((buf) => !cancelled && setBeatPeaks(peaks(buf)))
          .catch(() => {});
      })();
      return () => {
        cancelled = true;
      };
    }
    loadYouTubeAPI().then((YT) => {
      if (cancelled || !hostRef.current) return;
      // A fresh player per beat: reusing one iframe with cueVideoById can leave a black screen.
      try {
        playerRef.current?.destroy();
      } catch {}
      playerRef.current = null;
      attachPlayer(null);
      setReady(false);
      const el = document.createElement("div");
      hostRef.current.innerHTML = "";
      hostRef.current.appendChild(el);
      new YT.Player(el, {
        videoId,
        width: "100%",
        height: "100%",
        host: "https://www.youtube.com",
        playerVars: { playsinline: 1, rel: 0, modestbranding: 1, origin: window.location.origin },
        events: {
          onReady: (e: any) => {
            if (cancelled) return;
            playerRef.current = e.target;
            attachPlayer(e.target);
            setOffset(offsetRef.current);
            if (import.meta.env.DEV) (window as any).__player = e.target;
            setReady(true);
            const r = resumeRef.current;
            resumeRef.current = null;
            if (r && r.t > 0.5) {
              e.target.seekTo(r.t + offsetRef.current, true);
              noteSeek(r.t);
              if (r.play) e.target.playVideo();
            }
          },
          onError: (e: any) => {
            if (cancelled) return;
            const code = e?.data;
            setPlayerError(
              code === 101 || code === 150 || code === 153
                ? "YouTube won't play this one here. The uploader may have turned off embedding, or the link is wrong. Try another upload of the beat."
                : code === 100
                  ? "That video is private or was removed."
                  : "YouTube couldn't play this video. Try reloading or another link."
            );
          },
        },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [videoId]);
  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;
  const lastPlayerProjectRef = useRef<string | null>(null);

  // Fill in the song title from YouTube the first time a video is linked.
  useEffect(() => {
    if (!ready || !project || project.title !== "Untitled song" || !project.videoId || usingBacking) return;
    const id = project.id;
    const t = window.setInterval(() => {
      const data = (playerRef.current as any)?.getVideoData?.();
      if (data?.video_id === project.videoId && data.title) {
        update(id, (p) => (p.title === "Untitled song" ? { ...p, title: data.title } : p));
        window.clearInterval(t);
      }
    }, 400);
    const stop = window.setTimeout(() => window.clearInterval(t), 8000);
    return () => {
      window.clearInterval(t);
      window.clearTimeout(stop);
    };
  }, [ready, project?.id, project?.videoId, project?.title, usingBacking, update]);

  const seek = useCallback((t: number, play?: boolean) => {
    const p = playerRef.current;
    if (!p) return;
    const target = Math.max(0, t);
    p.seekTo(Math.max(0, target + getOffset()), true);
    noteSeek(target);
    if (play) p.playVideo();
  }, []);

  const togglePlay = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    if (isPlaying()) p.pauseVideo();
    else p.playVideo();
  }, []);

  /** Seeks to `target`, plays, and resolves once the beat is actually rolling near that spot. */
  const rollFrom = useCallback(async (target: number, token: () => boolean) => {
    const p = playerRef.current!;
    const off = getOffset();
    p.pauseVideo();
    p.seekTo(Math.max(0, target + off), true);
    noteSeek(Math.max(0, target));
    p.playVideo();
    const started = performance.now();
    while (performance.now() - started < 12000) {
      if (!token()) return false;
      const t = p.getCurrentTime() - off;
      if (p.getPlayerState() === 1 && t >= target - 0.25 && t <= target + 1.5) return true;
      await sleep(15);
    }
    return false;
  }, []);

  /* ---------- markers ---------- */
  const addMarker = useCallback(
    (time: number) => {
      if (!project) return;
      const m: Marker = { id: uid(), time: Math.round(time * 10) / 10, label: "", lyrics: "" };
      update(project.id, (p) => ({ ...p, markers: [...p.markers, m].sort((a, b) => a.time - b.time) }));
      setFocusMarkerId(m.id);
      return m;
    },
    [project, update]
  );

  const dropAtPlayhead = useCallback(() => {
    if (!playerRef.current) return flash("Load a beat first");
    const t = estimateNow();
    const tp = project?.tempo;
    addMarker(prefsRef.current.snap && tp?.bpm ? snapToBeat(t, tp) : t);
  }, [addMarker, flash, project?.tempo]);

  const changeMarker = useCallback(
    (id: string, patch: Partial<Marker>) => {
      if (!project) return;
      update(project.id, (p) => ({
        ...p,
        markers: p.markers.map((m) => (m.id === id ? { ...m, ...patch } : m)).sort((a, b) => a.time - b.time),
      }));
    },
    [project, update]
  );

  /** Moves a section to a new time; in cover mode its original lines move with it. */
  const moveMarker = useCallback(
    (id: string, t: number) => {
      if (!project) return;
      update(project.id, (p) => ({
        ...p,
        markers: p.markers
          .map((m) => {
            if (m.id !== id) return m;
            const d = t - m.time;
            return {
              ...m,
              time: Math.max(0, t),
              original: m.original?.map((l) => ({ ...l, t: Math.max(0, l.t + d) })),
            };
          })
          .sort((a, b) => a.time - b.time),
      }));
    },
    [project, update]
  );

  const removeMarker = useCallback(
    async (m: Marker) => {
      if (!project) return;
      const count = takes.filter((t) => t.markerId === m.id).length;
      const what = count ? ` and its ${count} flow${count > 1 ? "s" : ""}` : "";
      if ((m.lyrics.trim() || count) && !confirm(`Delete the ${fmt(m.time)} marker${what}?`)) return;
      update(project.id, (p) => ({ ...p, markers: p.markers.filter((x) => x.id !== m.id) }));
      await deleteTakesForMarker(project.id, m.id);
      setTakes((ts) => ts.filter((t) => t.markerId !== m.id));
    },
    [project, takes, update]
  );

  /* ---------- playback of takes ---------- */
  // The beat always rolls under a take so it stays in sync; "with beat" just mutes or unmutes it, live.
  const [takeBeat, setTakeBeat] = useState(true);
  const setBeatMuted = useCallback((muted: boolean) => {
    const p = playerRef.current;
    if (!p) return;
    if (muted) p.mute();
    else p.unMute();
  }, []);

  // Live sound-setting handles for whatever is playing, so fx changes are heard right away.
  const liveFx = useRef(new Map<string, { set(fx: TakeFx): void }>());
  const extraAudios = useRef<{ audio: HTMLAudioElement; url: string }[]>([]);
  const stopTake = useCallback(() => {
    playTokenRef.current++;
    const a = audioRef.current;
    for (const x of extraAudios.current) {
      x.audio.pause();
      URL.revokeObjectURL(x.url);
    }
    extraAudios.current = [];
    if (a) {
      a.audio.pause();
      URL.revokeObjectURL(a.url);
      audioRef.current = null;
      setBeatMuted(false);
    }
    liveFx.current.clear();
    setPlayingTakeId(null);
  }, [setBeatMuted]);

  const toggleTakeBeat = useCallback(
    (on: boolean) => {
      setTakeBeat(on);
      if (audioRef.current || songModeRef.current || compareRef.current) setBeatMuted(!on);
    },
    [setBeatMuted]
  );

  /** Starts `audio` so its first sample lines up with song time `start` (beat already rolling). */
  const startInSync = useCallback(async (audio: HTMLAudioElement, start: number, alive: () => boolean) => {
    const offset = estimateNow() - start + prefsRef.current.nudgeMs / 1000;
    if (offset >= 0) {
      audio.currentTime = offset;
      await audio.play().catch(() => {});
    } else {
      await sleep(-offset * 1000);
      if (alive()) await audio.play().catch(() => {});
    }
  }, []);

  const playTake = useCallback(
    async (take: Take) => {
      stopTake();
      if (rec) return;
      const token = ++playTokenRef.current;
      const alive = () => playTokenRef.current === token;
      const url = URL.createObjectURL(take.blob);
      const audio = new Audio(url);
      audio.preload = "auto";
      liveFx.current.set(take.id, routeAudio(audio, take.fx));
      audioRef.current = { audio, url, takeId: take.id };
      setPlayingTakeId(take.id);
      audio.onended = () => {
        if (!alive()) return;
        playerRef.current?.pauseVideo();
        stopTake();
      };
      // Layers recorded over this take play along with it.
      const layers = takesRef.current.filter((t) => t.layerOf === take.id);
      const layerAudios = layers.map((l) => {
        const u = URL.createObjectURL(l.blob);
        const el = new Audio(u);
        el.preload = "auto";
        liveFx.current.set(l.id, routeAudio(el, l.fx));
        extraAudios.current.push({ audio: el, url: u });
        return { el, l };
      });

      if (!playerRef.current) {
        await audio.play().catch(() => {});
        layerAudios.forEach(({ el }) => el.play().catch(() => {}));
        return;
      }
      setBeatMuted(!takeBeatRef.current);
      const ok = await rollFrom(Math.min(take.start, ...layers.map((l) => l.start)), alive);
      if (!ok || !alive()) {
        if (alive()) {
          flash("Couldn't start the beat");
          stopTake();
        }
        return;
      }
      layerAudios.forEach(({ el, l }) => startInSync(el, l.start, alive));
      await startInSync(audio, take.start, alive);
    },
    [rec, rollFrom, stopTake, setBeatMuted, flash, startInSync]
  );
  const takeBeatRef = useRef(takeBeat);
  takeBeatRef.current = takeBeat;

  /* ---------- recording ---------- */
  const getStream = useCallback(async () => {
    if (streamRef.current && streamRef.current.getAudioTracks().some((t) => t.readyState === "live"))
      return streamRef.current;
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    streamRef.current = s;
    setMicStream(s);
    return s;
  }, []);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [layerOver, setLayerOver] = useState<string | null>(null);
  const layerAudioRef = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const stopLayerBase = useCallback(() => {
    const a = layerAudioRef.current;
    if (a) {
      a.audio.pause();
      URL.revokeObjectURL(a.url);
    }
    layerAudioRef.current = null;
  }, []);

  const finishRecording = useCallback(() => {
    const r = recorderRef.current;
    recTokenRef.current++;
    if (r && r.recorder.state !== "inactive") r.recorder.stop();
    else {
      recorderRef.current = null;
      setRec(null);
    }
    stopLayerBase();
    playerRef.current?.pauseVideo();
  }, [stopLayerBase]);

  const startRecording = useCallback(
    async (m: Marker, over?: Take) => {
      if (!project || !playerRef.current) return flash("Load a beat first");
      if (rec) return finishRecording();
      stopTake();
      setLayerOver(over?.id ?? null);
      const token = ++recTokenRef.current;
      const alive = () => recTokenRef.current === token;
      setRec({ markerId: m.id, phase: "arming" });

      let stream: MediaStream;
      try {
        stream = await getStream();
      } catch {
        setRec(null);
        return flash("Mic blocked. Allow microphone access in the address bar.");
      }
      if (!alive()) return;

      const mime = pickMime();
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const projectId = project.id;

      recorder.onstop = async () => {
        const info = recorderRef.current;
        recorderRef.current = null;
        setRec(null);
        setLayerOver(null);
        if (!info || !chunks.length) return;
        const duration = (performance.now() - info.t0) / 1000;
        if (duration < 0.4) return;
        const blob = new Blob(chunks, { type: recorder.mimeType || mime || "audio/webm" });
        const existing = takesRef.current.filter((t) => t.markerId === info.markerId && !t.layerOf).length;
        const layerNo = over ? takesRef.current.filter((t) => t.layerOf === over.id).length + 1 : 0;
        const take: Take = {
          id: uid(),
          projectId,
          markerId: info.markerId,
          ...(over ? { layerOf: over.id } : {}),
          name: over ? `${over.name} layer ${layerNo}` : `Take ${existing + 1}`,
          start: info.startBeat,
          duration,
          mime: blob.type,
          blob,
          createdAt: Date.now(),
        };
        await saveTake(take);
        setTakes((ts) => [...ts, take]);
      };

      if (prefs.countIn) {
        metronome.unlock();
        await countIn(project.tempo?.bpm || 100, project.tempo?.beatsPerBar || 4);
        if (!alive()) return;
      }
      // Start the mic first so nothing at the marker gets clipped, then roll the beat.
      // Once the beat is steady, work out which beat time lines up with the take's first sample.
      const target = over ? Math.max(0, over.start) : Math.max(0, m.time - prefs.leadIn);
      await new Promise<void>((resolve) => {
        recorder.onstart = () => resolve();
        recorder.start(250);
      });
      const t0 = performance.now();
      recorderRef.current = { recorder, t0, startBeat: target, markerId: m.id };
      if (!alive()) return recorder.stop();
      const ok = await rollFrom(target, alive);
      if (!ok || !alive()) {
        if (alive()) {
          recTokenRef.current++;
          recorderRef.current = null;
          recorder.onstop = null;
          recorder.stop();
          setRec(null);
          setLayerOver(null);
          playerRef.current?.pauseVideo();
          flash("Couldn't start the beat");
        }
        return;
      }
      if (over) {
        // Play the take you're layering over, locked to the beat.
        const url = URL.createObjectURL(over.blob);
        const audio = new Audio(url);
        routeAudio(audio, over.fx);
        layerAudioRef.current = { audio, url };
        startInSync(audio, over.start, alive);
      }
      setRec({ markerId: m.id, phase: "recording" });
      await sleep(400);
      if (recorderRef.current?.recorder === recorder && isPlaying()) {
        recorderRef.current.startBeat = Math.round((estimateNow() - (performance.now() - t0) / 1000) * 1000) / 1000;
      }
    },
    [project, rec, finishRecording, stopTake, getStream, rollFrom, prefs.leadIn, prefs.countIn, flash, startInSync]
  );
  const takesRef = useRef(takes);
  takesRef.current = takes;

  // If the beat stops (ended or paused in the player) while recording, wrap up the take.
  // Only counts as "stopped" after the clock has actually seen the beat playing during this take.
  const playing = useClock((s) => s.playing);
  const sawPlayingRef = useRef(false);
  useEffect(() => {
    if (rec?.phase !== "recording") {
      sawPlayingRef.current = false;
      return;
    }
    if (playing) sawPlayingRef.current = true;
    else if (sawPlayingRef.current) finishRecording();
  }, [playing, rec, finishRecording]);

  // Release the mic when leaving.
  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  /* ---------- punch-in: re-record part of a take ---------- */
  // Flow: Punch -> the beat and the take play from the take's start -> press "Punch in" (or P) where you want
  // to come in -> rap -> Stop. The new part replaces that stretch; the rest of the take stays. Saved as a new take.
  const [punch, setPunch] = useState<{ takeId: string; phase: "arming" | "monitor" | "recording" | "saving" } | null>(null);
  const punchRef = useRef<{
    take: Take;
    recorder: MediaRecorder;
    chunks: Blob[];
    t0: number;
    recStart: number;
    audio: HTMLAudioElement;
    url: string;
    punchIn: number | null;
    token: number;
  } | null>(null);
  const punchTokenRef = useRef(0);

  const cleanupPunch = useCallback(() => {
    const p = punchRef.current;
    if (p) {
      p.audio.pause();
      URL.revokeObjectURL(p.url);
    }
    punchRef.current = null;
  }, []);

  const stopPunch = useCallback(async () => {
    const p = punchRef.current;
    if (!p) return setPunch(null);
    punchTokenRef.current++;
    const punchOut = estimateNow();
    playerRef.current?.pauseVideo();
    p.audio.pause();
    const done = new Promise<void>((r) => {
      p.recorder.onstop = () => r();
    });
    if (p.recorder.state !== "inactive") p.recorder.stop();
    await done;
    const { take, chunks, recStart, punchIn } = p;
    cleanupPunch();
    if (punchIn === null || punchOut - punchIn < 0.2) {
      setPunch(null);
      if (punchIn === null) flash("Punch cancelled: you didn't punch in");
      return;
    }
    setPunch({ takeId: take.id, phase: "saving" });
    try {
      const recBlob = new Blob(chunks, { type: p.recorder.mimeType || "audio/webm" });
      const { blob, duration } = await splicePunch(take.blob, take.start, recBlob, recStart, punchIn, punchOut);
      const nt: Take = {
        id: uid(),
        projectId: take.projectId,
        markerId: take.markerId,
        name: `${take.name.replace(/ \(punch.*\)$/, "")} (punch)`,
        ...(take.layerOf ? { layerOf: take.layerOf } : {}),
        ...(take.fx ? { fx: take.fx } : {}),
        start: take.start,
        duration,
        mime: "audio/wav",
        blob,
        createdAt: Date.now(),
      };
      await saveTake(nt);
      setTakes((ts) => [...ts, nt]);
      flash(`Saved "${nt.name}". The original take is still there.`);
    } catch {
      flash("Couldn't save the punch-in");
    }
    setPunch(null);
  }, [cleanupPunch, flash]);

  const startPunch = useCallback(
    async (take: Take) => {
      if (rec || punch || !playerRef.current) return;
      stopTake();
      const token = ++punchTokenRef.current;
      const alive = () => punchTokenRef.current === token;
      setPunch({ takeId: take.id, phase: "arming" });
      let stream: MediaStream;
      try {
        stream = await getStream();
      } catch {
        setPunch(null);
        return flash("Mic blocked. Allow microphone access in the address bar.");
      }
      const mime = pickMime();
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      await new Promise<void>((r) => {
        recorder.onstart = () => r();
        recorder.start(250);
      });
      const t0 = performance.now();
      const url = URL.createObjectURL(take.blob);
      const audio = new Audio(url);
      punchRef.current = { take, recorder, chunks, t0, recStart: take.start, audio, url, punchIn: null, token };
      setBeatMuted(!takeBeatRef.current);
      const ok = await rollFrom(take.start, alive);
      if (!ok || !alive()) {
        if (alive()) {
          recorder.stop();
          cleanupPunch();
          setPunch(null);
          flash("Couldn't start the beat");
        }
        return;
      }
      audio.currentTime = Math.max(0, estimateNow() - take.start);
      audio.play().catch(() => {});
      audio.onended = () => alive() && punchRef.current?.punchIn === null && stopPunch();
      setPunch({ takeId: take.id, phase: "monitor" });
      await sleep(400);
      if (alive() && punchRef.current) punchRef.current.recStart = estimateNow() - (performance.now() - t0) / 1000;
    },
    [rec, punch, stopTake, getStream, setBeatMuted, rollFrom, cleanupPunch, stopPunch, flash]
  );

  const punchIn = useCallback(() => {
    const p = punchRef.current;
    if (!p || p.punchIn !== null) return;
    p.punchIn = estimateNow();
    p.audio.volume = 0; // you hear yourself, not the old take, from here
    setPunch({ takeId: p.take.id, phase: "recording" });
  }, []);

  // The beat stopping ends a punch too.
  useEffect(() => {
    if (!playing && (punch?.phase === "monitor" || punch?.phase === "recording")) {
      const t = window.setTimeout(() => !isPlaying() && stopPunch(), 300);
      return () => window.clearTimeout(t);
    }
  }, [playing, punch?.phase, stopPunch]);

  /* ---------- export vocals ---------- */
  const [exporting, setExporting] = useState(false);
  const exportVocals = useCallback(async (withBeat = false) => {
    if (!project || !songTakesRef.current.length) return flash("Record a flow first");
    setExporting(true);
    try {
      const beat = withBeat && project.beat ? await getBeat(project.id) : null;
      if (withBeat && !beat) throw new Error("no beat");
      const blob = await mixTakes(songTakesRef.current, beat ? { blob: beat.blob, gain: 0.8 } : null);
      const a = document.createElement("a");
      const url = URL.createObjectURL(blob);
      a.href = url;
      a.download = `${project.title.replace(/[^\w\- ]+/g, "").trim() || "song"} - ${beat ? "full mix" : "vocals"}.wav`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      flash(beat ? "Full mix exported: your keeper takes over the beat." : "Vocals exported. The file starts at 0:00 so it lines up with the beat.");
    } catch {
      flash("Export failed");
    } finally {
      setExporting(false);
    }
  }, [project, flash]);

  const fxTimers = useRef(new Map<string, number>());
  const changeFx = useCallback((take: Take, fx: TakeFx) => {
    liveFx.current.get(take.id)?.set(fx);
    let next: Take | null = null;
    setTakes((ts) =>
      ts.map((t) => {
        if (t.id !== take.id) return t;
        next = { ...t, fx };
        return next;
      })
    );
    window.clearTimeout(fxTimers.current.get(take.id));
    fxTimers.current.set(
      take.id,
      window.setTimeout(() => next && saveTake(next), 400)
    );
  }, []);

  const renameTake = useCallback(async (take: Take, name: string) => {
    const next = { ...take, name };
    setTakes((ts) => ts.map((t) => (t.id === take.id ? next : t)));
    await saveTake(next);
  }, []);

  const removeTake = useCallback(
    async (take: Take) => {
      const layers = takesRef.current.filter((t) => t.layerOf === take.id);
      if (!confirm(`Delete "${take.name}"${layers.length ? ` and its ${layers.length} layer${layers.length > 1 ? "s" : ""}` : ""}?`)) return;
      if (playingTakeId === take.id) stopTake();
      const gone = new Set([take.id, ...layers.map((l) => l.id)]);
      await Promise.all([...gone].map(deleteTake));
      setTakes((ts) => ts.filter((t) => !gone.has(t.id)));
    },
    [playingTakeId, stopTake]
  );

  /* ---------- projects ---------- */
  const createProject = useCallback(async () => {
    const p = newProject();
    savedRef.current.set(p.id, p);
    await saveProject(p);
    setProjects((ps) => [p, ...ps]);
    setCurrentId(p.id);
    setLinkDraft("");
    setNavOpen(false);
    setView("song");
  }, [setView]);

  const removeProject = useCallback(
    async (p: Project) => {
      if (!confirm(`Delete "${p.title}" with all its lyrics and flows? This can't be undone.`)) return;
      await deleteProject(p.id);
      savedRef.current.delete(p.id);
      const rest = projects.filter((x) => x.id !== p.id);
      if (rest.length === 0) {
        const fresh = newProject();
        savedRef.current.set(fresh.id, fresh);
        await saveProject(fresh);
        rest.push(fresh);
      }
      setProjects(rest);
      if (currentId === p.id) setCurrentId(rest[0].id);
    },
    [projects, currentId]
  );

  const switchProject = useCallback(
    (id: string) => {
      if (rec) finishRecording();
      stopTake();
      setCurrentId(id);
      setNavOpen(false);
      setLinkDraft("");
      setView("song");
    },
    [rec, finishRecording, stopTake, setView]
  );

  const linkVideo = useCallback(
    (raw: string) => {
      if (!project) return;
      const id = parseVideoId(raw);
      if (!id) return flash("That doesn't look like a YouTube link");
      if (project.beat) deleteBeat(project.id).catch(() => {});
      update(project.id, (p) => {
        const { beat, ...rest } = p;
        return beat ? { ...rest, url: raw.trim(), videoId: id, autoBpm: undefined, autoKey: undefined } : { ...p, url: raw.trim(), videoId: id };
      });
      setLinkDraft("");
      const start = parseStartParam(raw);
      if (start) setTimeout(() => seek(start), 1500);
    },
    [project, update, flash, seek]
  );

  /** Your own beat file: stored on this device, then BPM and key are worked out from the audio. */
  const [beatBusy, setBeatBusy] = useState<string | null>(null);
  const analyzeFileInto = useCallback(
    async (id: string, buf: AudioBuffer) => {
      setBeatBusy("Finding BPM and key…");
      await sleep(30);
      try {
        const res = await analyzeBeat(buf);
        if (res) {
          update(id, (x) => {
            const next: Project = { ...x };
            if (res.bpm) {
              next.autoBpm = { bpm: res.bpm, from: "audio", downbeat: res.downbeat };
              if (!x.tempo || x.tempo.source === "auto") next.tempo = { bpm: res.bpm, downbeat: res.downbeat, beatsPerBar: 4, source: "auto" };
            }
            if (res.key) {
              next.autoKey = { ...res.key, from: "audio" };
              if (!x.key || x.key.source === "auto") next.key = { ...res.key, source: "auto" };
            }
            return next;
          });
          flash([res.bpm && `${res.bpm} BPM`, res.key && `key ${keyName(res.key)}`].filter(Boolean).join(" · ") + " from the file");
        } else flash("Beat loaded. Couldn't find a clear BPM, so tap it in.");
      } finally {
        setBeatBusy(null);
      }
    },
    [update, flash]
  );
  const loadBeatFile = useCallback(
    async (file: File) => {
      if (!project) return;
      if (!file.type.startsWith("audio/") && !/\.(mp3|wav|m4a|aac|ogg|flac|webm)$/i.test(file.name)) return flash("That isn't an audio file");
      if (file.size > 200 * 1024 * 1024) return flash("That file is over 200 MB");
      const id = project.id;
      setBeatBusy("Loading the beat…");
      let buf: AudioBuffer;
      try {
        buf = await decodeFile(file);
      } catch {
        setBeatBusy(null);
        return flash("Couldn't read that audio file. Try an MP3 or WAV.");
      }
      await saveBeat({ projectId: id, name: file.name, mime: file.type || "audio/mpeg", blob: file });
      update(id, (p) => ({
        ...p,
        title: p.title === "Untitled song" ? titleFromFile(file.name) : p.title,
        url: "",
        videoId: "",
        beat: { name: file.name, duration: buf.duration, size: file.size },
        autoBpm: null,
        autoKey: null,
        tempo: p.tempo?.source === "manual" ? p.tempo : undefined,
        key: p.key?.source === "manual" ? p.key : undefined,
      }));
      await analyzeFileInto(id, buf);
    },
    [project, update, flash, analyzeFileInto]
  );
  /** Re-run detection on the stored beat file (the Find button for file songs). */
  const reanalyzeBeat = useCallback(async () => {
    if (!project?.beat) return;
    const b = await getBeat(project.id).catch(() => null);
    if (!b) return flash("The beat file is missing on this device");
    setBeatBusy("Finding BPM and key…");
    try {
      await analyzeFileInto(project.id, await decodeFile(b.blob));
    } catch {
      setBeatBusy(null);
      flash("Couldn't read the beat file");
    }
  }, [project, flash, analyzeFileInto]);
  const beatInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const removeBeatFile = useCallback(async () => {
    if (!project?.beat) return;
    if (!confirm(`Remove the beat file "${project.beat.name}" from this song? Your lyrics and takes stay.`)) return;
    await deleteBeat(project.id).catch(() => {});
    update(project.id, (p) => {
      const { beat, ...rest } = p;
      return rest;
    });
  }, [project, update]);

  /* ---------- active marker + follow ---------- */
  const times = useMemo(() => markers.map((m) => m.time), [markers]);
  const activeIndex = useClock((s) => {
    let idx = -1;
    for (let i = 0; i < times.length; i++) if (times[i] <= s.now + 0.05) idx = i;
    return idx;
  });
  const activeId = activeIndex >= 0 ? markers[activeIndex]?.id : null;

  useEffect(() => {
    if (!prefs.follow || !activeId || !isPlaying()) return;
    const el = document.getElementById(`m-${activeId}`);
    const ae = document.activeElement as HTMLElement | null;
    if (ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT")) return; // don't yank while typing
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeId, prefs.follow]);

  /* ---------- cover / parody ---------- */
  const importCover = useCallback(
    (imported: Marker[], hit: LyricHit) => {
      if (!project) return;
      const oldImported = project.markers.filter((m) => m.original);
      if (oldImported.length) {
        const ok = confirm(
          `This song already has imported lyrics. Replace them with "${hit.track}"?\n\nYour written lines and takes stay with the nearest new section. Empty imported sections are removed, so nothing gets doubled.`
        );
        if (!ok) return;
      }
      const hasTakes = (id: string) => takes.some((t) => t.markerId === id);
      // Pair new sections with the old ones they replace (by lyric lines, then time) so your words and takes carry over.
      const hasContent = (m: Marker) => !!m.lyrics.trim() || hasTakes(m.id);
      const claim = pairSections(oldImported, imported, (m) => (hasContent(m) ? 1 : 0));
      const used = new Set([...claim.values()].map((m) => m.id));
      const merged = imported.map((n, i) => {
        const o = claim.get(i);
        return o ? { ...n, id: o.id, label: o.label, lyrics: o.lyrics } : n;
      });
      // Old sections with no match: keep only ones you wrote or recorded in, as plain sections
      // (without the old imported lines, so they don't show up as copies).
      const leftovers = oldImported
        .filter((o) => !used.has(o.id) && (o.lyrics.trim() || hasTakes(o.id)))
        .map(({ original, ...m }) => m as Marker);
      update(project.id, (p) => ({
        ...p,
        markers: [...p.markers.filter((m) => !m.original), ...leftovers, ...merged].sort((a, b) => a.time - b.time),
        cover: { track: hit.track, artist: hit.artist, showOriginal: p.cover?.showOriginal ?? true },
        autoBpm: undefined,
      }));
      setCoverOpen(false);
      flash(oldImported.length ? `Replaced with ${merged.length} sections` : `Imported ${merged.length} sections`);
    },
    [project, takes, update, flash]
  );

  /** Moves every imported section (and its original lines) earlier or later. */
  const shiftCover = useCallback(
    (delta: number) => {
      if (!project) return;
      update(project.id, (p) => ({
        ...p,
        markers: p.markers
          .map((m) =>
            m.original
              ? {
                  ...m,
                  time: Math.max(0, Math.round((m.time + delta) * 100) / 100),
                  original: m.original.map((l) => ({ ...l, t: Math.max(0, l.t + delta) })),
                }
              : m
          )
          .sort((a, b) => a.time - b.time),
      }));
    },
    [project, update]
  );

  const removeCover = useCallback(() => {
    if (!project) return;
    const n = project.markers.filter((m) => m.original && !m.lyrics.trim()).length;
    if (!confirm(`Remove the imported original lyrics? ${n} empty imported section${n === 1 ? "" : "s"} will be deleted; sections you've written in stay.`)) return;
    const gone = new Set(project.markers.filter((m) => m.original && !m.lyrics.trim() && !takes.some((t) => t.markerId === m.id)).map((m) => m.id));
    update(project.id, (p) => ({
      ...p,
      cover: undefined,
      markers: p.markers.filter((m) => !gone.has(m.id)).map(({ original, ...m }) => m),
    }));
  }, [project, takes, update]);

  /* ---------- loop a section ---------- */
  const [loop, setLoop] = useState<{ markerId: string; start: number; end: number } | null>(null);
  const toggleLoop = useCallback(
    (m: Marker, i: number) => {
      if (loop?.markerId === m.id) {
        setLoop(null);
        return;
      }
      const dur = playerRef.current ? playerRef.current.getDuration() - getOffset() : 0;
      const next = markers[i + 1]?.time;
      const end = next !== undefined ? next : Math.min(dur || m.time + 16, m.time + 16);
      if (end - m.time < 0.5) return flash("This section is too short to loop");
      stopTake();
      setLoop({ markerId: m.id, start: m.time, end });
      seek(m.time, true);
    },
    [loop, markers, seek, stopTake, flash]
  );
  useEffect(() => {
    if (!loop) return;
    const t = window.setInterval(() => {
      if (!isPlaying()) return;
      const now = estimateNow();
      if (now >= loop.end - 0.03 || now < loop.start - 2) seek(loop.start);
    }, 25);
    return () => window.clearInterval(t);
  }, [loop, seek]);
  useEffect(() => {
    if (rec) setLoop(null);
  }, [rec]);
  useEffect(() => setLoop(null), [currentId]);

  /* ---------- keepers + play song ---------- */
  const starTake = useCallback(async (take: Take) => {
    const on = !take.starred;
    const changed: Take[] = [];
    setTakes((ts) =>
      ts.map((t) => {
        if (t.markerId !== take.markerId) return t;
        const next = t.id === take.id ? on : false;
        if (!!t.starred === next) return t;
        const u = { ...t, starred: next };
        changed.push(u);
        return u;
      })
    );
    await sleep(0);
    await Promise.all(changed.map(saveTake));
  }, []);

  /** One take per section: the starred one, else the newest. */
  const songTakes = useMemo(() => {
    const byMarker = new Map<string, Take>();
    for (const t of takes) {
      if (t.layerOf) continue;
      if (!markers.some((m) => m.id === t.markerId)) continue;
      const cur = byMarker.get(t.markerId);
      if (!cur || (t.starred && !cur.starred) || (!cur.starred && t.createdAt > cur.createdAt)) byMarker.set(t.markerId, t);
    }
    return [...byMarker.values()].sort((a, b) => a.start - b.start);
  }, [takes, markers]);
  /** Keeper takes plus the layers recorded over them. */
  const songClips = useMemo(() => {
    const ids = new Set(songTakes.map((t) => t.id));
    return [...songTakes, ...takes.filter((t) => t.layerOf && ids.has(t.layerOf))].sort((a, b) => a.start - b.start);
  }, [songTakes, takes]);
  const songTakesRef = useRef(songClips);
  songTakesRef.current = songClips;
  const songTakeIds = useMemo(() => new Map(songTakes.map((t) => [t.markerId, t.id])), [songTakes]);

  const [songMode, setSongMode] = useState(false);
  const songModeRef = useRef(false);
  songModeRef.current = songMode;
  const songAudios = useRef(new Map<string, { audio: HTMLAudioElement; url: string }>());
  const stopSong = useCallback(() => {
    if (songModeRef.current) setBeatMuted(false);
    songModeRef.current = false;
    setSongMode(false);
    for (const { audio, url } of songAudios.current.values()) {
      audio.pause();
      URL.revokeObjectURL(url);
    }
    songAudios.current.clear();
  }, [setBeatMuted]);
  const playSong = useCallback(async () => {
    if (songMode) {
      stopSong();
      playerRef.current?.pauseVideo();
      return;
    }
    if (!songTakes.length) return flash("Record a flow first");
    if (!playerRef.current) return flash("Load the beat first");
    stopTake();
    setLoop(null);
    songModeRef.current = true;
    setSongMode(true);
    setBeatMuted(!takeBeatRef.current);
    seek(Math.max(0, songTakes[0].start - 1), true);
  }, [songMode, songTakes, stopSong, stopTake, setBeatMuted, seek, flash]);
  // While in song mode, keep every chosen take locked to the beat, even if you seek around.
  useEffect(() => {
    if (!songMode) return;
    const t = window.setInterval(() => {
      const playing = isPlaying();
      const now = estimateNow() + prefs.nudgeMs / 1000;
      const live = new Set(songClips.map((x) => x.id));
      for (const [id, a] of songAudios.current) {
        if (!live.has(id)) {
          a.audio.pause();
          URL.revokeObjectURL(a.url);
          songAudios.current.delete(id);
        }
      }
      for (const take of songClips) {
        const rel = now - take.start;
        let a = songAudios.current.get(take.id);
        const inside = playing && rel >= 0 && rel < take.duration - 0.05;
        if (!inside) {
          if (a && !a.audio.paused) a.audio.pause();
          continue;
        }
        if (!a) {
          const url = URL.createObjectURL(take.blob);
          a = { audio: new Audio(url), url };
          liveFx.current.set(take.id, routeAudio(a.audio, take.fx));
          songAudios.current.set(take.id, a);
        }
        if (a.audio.paused) {
          a.audio.currentTime = rel;
          a.audio.play().catch(() => {});
        } else if (Math.abs(a.audio.currentTime - rel) > 0.2) {
          a.audio.currentTime = rel;
        }
      }
    }, 30);
    return () => window.clearInterval(t);
  }, [songMode, songClips, prefs.nudgeMs]);
  useEffect(() => {
    if (rec || playingTakeId) stopSong();
  }, [rec, playingTakeId, stopSong]);
  useEffect(() => stopSong, [currentId, stopSong]);

  /* ---------- A/B: two takes in sync, flip between them ---------- */
  const [compare, setCompare] = useState<{ markerId: string; a: string; b: string; side: "a" | "b"; playing: boolean } | null>(null);
  const compareRef = useRef(compare);
  compareRef.current = compare;
  const compareAudios = useRef<{ a: HTMLAudioElement; b: HTMLAudioElement; urls: string[] } | null>(null);
  const compareTokenRef = useRef(0);
  const stopCompareAudio = useCallback(() => {
    compareTokenRef.current++;
    const c = compareAudios.current;
    if (c) {
      c.a.pause();
      c.b.pause();
      c.urls.forEach((u) => URL.revokeObjectURL(u));
    }
    compareAudios.current = null;
    liveFx.current.clear();
  }, []);
  const openCompare = useCallback(
    (m: Marker) => {
      const bases = takesRef.current.filter((t) => t.markerId === m.id && !t.layerOf);
      if (bases.length < 2) return;
      const starred = bases.find((t) => t.starred);
      const newest = [...bases].reverse();
      const a = starred ?? newest[1];
      const b = newest.find((t) => t.id !== a.id)!;
      stopTake();
      stopSong();
      setCompare({ markerId: m.id, a: a.id, b: b.id, side: "a", playing: false });
    },
    [stopTake, stopSong]
  );
  const closeCompare = useCallback(() => {
    stopCompareAudio();
    if (compareRef.current?.playing) {
      playerRef.current?.pauseVideo();
      setBeatMuted(false);
    }
    setCompare(null);
  }, [stopCompareAudio, setBeatMuted]);
  const playCompare = useCallback(async () => {
    const c = compareRef.current;
    if (!c) return;
    if (c.playing) {
      stopCompareAudio();
      playerRef.current?.pauseVideo();
      setBeatMuted(false);
      return setCompare({ ...c, playing: false });
    }
    const ta = takesRef.current.find((t) => t.id === c.a);
    const tb = takesRef.current.find((t) => t.id === c.b);
    if (!ta || !tb || !playerRef.current) return;
    stopTake();
    stopCompareAudio();
    const token = ++compareTokenRef.current;
    const alive = () => compareTokenRef.current === token;
    const mk = (t: Take) => {
      const url = URL.createObjectURL(t.blob);
      const el = new Audio(url);
      el.preload = "auto";
      liveFx.current.set(t.id, routeAudio(el, t.fx));
      return { el, url };
    };
    const A = mk(ta);
    const B = mk(tb);
    A.el.muted = c.side !== "a";
    B.el.muted = c.side !== "b";
    compareAudios.current = { a: A.el, b: B.el, urls: [A.url, B.url] };
    let ended = 0;
    const onEnd = () => {
      if (++ended < 2 || !alive()) return;
      stopCompareAudio();
      playerRef.current?.pauseVideo();
      setBeatMuted(false);
      setCompare((x) => x && { ...x, playing: false });
    };
    A.el.onended = onEnd;
    B.el.onended = onEnd;
    setCompare({ ...c, playing: true });
    setBeatMuted(!takeBeatRef.current);
    const ok = await rollFrom(Math.min(ta.start, tb.start), alive);
    if (!ok || !alive()) return;
    startInSync(A.el, ta.start, alive);
    startInSync(B.el, tb.start, alive);
  }, [stopTake, stopCompareAudio, setBeatMuted, rollFrom, startInSync]);
  const flipCompare = useCallback((side?: "a" | "b") => {
    const c = compareRef.current;
    if (!c) return;
    const next = side ?? (c.side === "a" ? "b" : "a");
    const au = compareAudios.current;
    if (au) {
      au.a.muted = next !== "a";
      au.b.muted = next !== "b";
    }
    setCompare({ ...c, side: next });
  }, []);
  useEffect(() => {
    if (compare && (rec || playingTakeId || songMode)) closeCompare();
  }, [rec, playingTakeId, songMode]);
  useEffect(() => closeCompare, [currentId]);
  // The beat stopping ends the comparison playback.
  useEffect(() => {
    if (!playing && compare?.playing) {
      const t = window.setTimeout(() => {
        if (!isPlaying() && compareRef.current?.playing) {
          stopCompareAudio();
          setBeatMuted(false);
          setCompare((x) => x && { ...x, playing: false });
        }
      }, 400);
      return () => window.clearTimeout(t);
    }
  }, [playing, compare?.playing]);

  /* ---------- karaoke / backing track ---------- */
  const [backingDraft, setBackingDraft] = useState("");
  const linkBacking = useCallback(() => {
    if (!project) return;
    const id = parseVideoId(backingDraft);
    if (!id) return flash("That doesn't look like a YouTube link");
    update(project.id, (p) => ({ ...p, backing: { videoId: id, url: backingDraft.trim(), offset: 0 }, source: "backing" }));
    setBackingDraft("");
    flash("Karaoke track added. Nudge its timing if the lines are early or late.");
  }, [project, backingDraft, update, flash]);
  const setSource = useCallback(
    (src: "main" | "backing") => project && update(project.id, (p) => ({ ...p, source: src })),
    [project, update]
  );
  const setBackingOffset = useCallback(
    (o: number) => project && update(project.id, (p) => (p.backing ? { ...p, backing: { ...p.backing, offset: o } } : p)),
    [project, update]
  );
  const removeBacking = useCallback(
    () => project && update(project.id, (p) => ({ ...p, backing: undefined, source: "main" })),
    [project, update]
  );
  const karaokeSearchUrl = project?.cover
    ? `https://www.youtube.com/results?search_query=${encodeURIComponent(`${project.cover.track} ${project.cover.artist} karaoke instrumental`)}`
    : `https://www.youtube.com/results?search_query=${encodeURIComponent(`${project?.title ?? ""} karaoke instrumental`)}`;

  /* ---------- backup ---------- */
  const fileRef = useRef<HTMLInputElement>(null);
  const [busyBackup, setBusyBackup] = useState(false);
  const doExport = useCallback(
    async (all: boolean) => {
      if (!project) return;
      setBusyBackup(true);
      try {
        await exportBackup(all ? projectsRef.current : [project]);
        flash(all ? "Backup of all songs downloaded" : "Song backup downloaded");
      } catch {
        flash("Export failed");
      } finally {
        setBusyBackup(false);
      }
    },
    [project, flash]
  );
  const doImport = useCallback(
    async (file: File) => {
      setBusyBackup(true);
      try {
        const res = await importBackup(file, new Set(projectsRef.current.map((p) => p.id)));
        res.projects.forEach((p) => savedRef.current.set(p.id, p));
        setProjects((ps) => [...res.projects, ...ps]);
        if (res.projects[0]) switchProject(res.projects[0].id);
        flash(`Imported ${res.projects.length} song${res.projects.length === 1 ? "" : "s"} and ${res.takes} take${res.takes === 1 ? "" : "s"}`);
      } catch (e: any) {
        flash(e?.message || "Import failed");
      } finally {
        setBusyBackup(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [switchProject, flash]
  );

  /* ---------- install as an app ---------- */
  const [installEvt, setInstallEvt] = useState<any>(null);
  const standalone =
    typeof window !== "undefined" &&
    (window.matchMedia?.("(display-mode: standalone)").matches || (navigator as any).standalone === true);
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  useEffect(() => {
    const on = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e);
    };
    window.addEventListener("beforeinstallprompt", on);
    window.addEventListener("appinstalled", () => setInstallEvt(null));
    return () => window.removeEventListener("beforeinstallprompt", on);
  }, []);

  /* ---------- tools drawer: notes, rhymes, history ---------- */
  const [drawer, setDrawer] = useState<DrawerTab | null>(null);
  const [performing, setPerforming] = useState(false);
  const performingRef = useRef(false);
  performingRef.current = performing;
  const [rhymeWord, setRhymeWord] = useState("");
  const [historyKey, setHistoryKey] = useState(0);
  const toggleDrawer = (t: DrawerTab) => setDrawer((d) => (d === t ? null : t));
  const onSelectWord = useCallback((w: string) => {
    setRhymeWord(w);
  }, []);

  // Auto-save a version of the lyrics ~20s after you stop typing, if anything changed.
  const sig = (p: Project) => JSON.stringify([p.markers.map((m) => [m.id, m.label, m.lyrics]), p.notes ?? ""]);
  const lastSigRef = useRef(new Map<string, string>());
  const takeSnapshot = useCallback(async (p: Project, force = false) => {
    const now = sig(p);
    if (!lastSigRef.current.has(p.id)) {
      const prev = (await listSnapshots(p.id))[0];
      lastSigRef.current.set(p.id, prev ? JSON.stringify([prev.markers.map((m) => [m.id, m.label, m.lyrics]), prev.notes ?? ""]) : "");
    }
    if (!force && lastSigRef.current.get(p.id) === now) return;
    const hasWords = p.markers.some((m) => m.lyrics.trim()) || (p.notes ?? "").trim();
    if (!hasWords) return;
    lastSigRef.current.set(p.id, now);
    await saveSnapshot({
      id: uid(),
      projectId: p.id,
      at: Date.now(),
      markers: p.markers.map((m) => ({ id: m.id, time: m.time, label: m.label, lyrics: m.lyrics, original: m.original })),
      notes: p.notes ?? "",
    });
    setHistoryKey((k) => k + 1);
  }, []);
  const lyricSig = project ? sig(project) : "";
  useEffect(() => {
    if (!project) return;
    const p = project;
    const t = window.setTimeout(() => takeSnapshot(p), 20000);
    return () => window.clearTimeout(t);
  }, [lyricSig]);
  useEffect(() => {
    // Save one when you leave a song too.
    const p = project;
    return () => {
      if (p) takeSnapshot(projectsRef.current.find((x) => x.id === p.id) ?? p);
    };
  }, [project?.id]);

  const restoreSnapshot = useCallback(
    async (snap: Snapshot) => {
      if (!project) return;
      if (!confirm("Restore this version? Your current lyrics are saved to History first.")) return;
      await takeSnapshot(project, true);
      update(project.id, (p) => {
        const byId = new Map(snap.markers.map((m) => [m.id, m]));
        const markers = p.markers.map((m) => {
          const s = byId.get(m.id);
          return s ? { ...m, label: s.label, lyrics: s.lyrics } : m;
        });
        for (const s of snap.markers) {
          if (markers.some((m) => m.id === s.id)) continue;
          // Same spot already has a section: put the old words there instead of adding a copy.
          const i = markers.findIndex((m) => Math.abs(m.time - s.time) <= 0.6);
          if (i >= 0) {
            if (!markers[i].lyrics.trim()) markers[i] = { ...markers[i], lyrics: s.lyrics, label: markers[i].label || s.label };
            continue;
          }
          markers.push({ id: s.id, time: s.time, label: s.label, lyrics: s.lyrics, ...(s.original ? { original: s.original } : {}) });
        }
        return { ...p, markers: markers.sort((a, b) => a.time - b.time), notes: snap.notes };
      });
      lastSigRef.current.delete(project.id);
      flash("Version restored");
    },
    [project, takeSnapshot, update, flash]
  );

  /* ---------- tempo + metronome ---------- */
  const tempo = project?.tempo && project.tempo.bpm > 0 ? project.tempo : null;
  const setTempo = useCallback(
    (patch: Partial<{ bpm: number; downbeat: number; beatsPerBar: number }> | null) => {
      if (!project) return;
      update(project.id, (p) => {
        if (!patch) return { ...p, tempo: undefined };
        const cur = p.tempo ?? { bpm: 0, downbeat: 0, beatsPerBar: 4 };
        const next = { ...cur, ...patch };
        if (patch.bpm !== undefined && patch.bpm !== cur.bpm) next.source = "manual";
        next.bpm = Math.max(0, Math.min(240, Math.round(next.bpm * 2) / 2));
        return { ...p, tempo: next.bpm > 0 ? next : undefined };
      });
    },
    [project, update]
  );
  useEffect(() => {
    if (prefs.metronome && tempo && view === "song") metronome.start(tempo);
    else metronome.stop();
  }, [prefs.metronome, tempo?.bpm, tempo?.downbeat, tempo?.beatsPerBar, view]);
  useEffect(() => () => metronome.stop(), []);
  const tapper = useMemo(() => makeTapper(), []);
  const tapFirstRef = useRef<number | null>(null);
  const [tapCount, setTapCount] = useState(0);
  const tapResetRef = useRef<number | undefined>(undefined);
  const tapTempo = useCallback(() => {
    metronome.unlock();
    const r = tapper.tap();
    setTapCount(r.count);
    window.clearTimeout(tapResetRef.current);
    tapResetRef.current = window.setTimeout(() => setTapCount(0), 2200);
    if (r.first) tapFirstRef.current = isPlaying() ? estimateNow() : null;
    if (r.bpm) setTempo({ bpm: r.bpm, ...(tapFirstRef.current !== null ? { downbeat: tapFirstRef.current } : {}) });
  }, [tapper, setTempo]);
  // Automatic BPM: covers check a song database; beats check the video name, then its description.
  const [bpmBusy, setBpmBusy] = useState<string | null>(null);
  const runAutoBpm = useCallback(
    async (p: Project, announce: boolean) => {
      setBpmBusy("Looking for the BPM…");
      const title = (playerRef.current as any)?.getVideoData?.()?.title || p.title;
      const found = await findBpm({ videoTitle: title || "", videoId: p.videoId, cover: p.cover ? { track: p.cover.track, artist: p.cover.artist } : null });
      const k = keyInText(title || "") ?? keyInText(p.title || "");
      setBpmBusy(null);
      update(p.id, (x) => {
        const next: Project = { ...x, autoBpm: found };
        if (k) {
          next.autoKey = { ...k, from: "video name" };
          if (!x.key || x.key.source === "auto") next.key = { ...k, source: "auto" };
        } else if (x.autoKey === undefined) next.autoKey = null;
        if (found && (!x.tempo || x.tempo.source === "auto")) next.tempo = { bpm: found.bpm, downbeat: x.tempo?.downbeat ?? 0, beatsPerBar: 4, source: "auto" };
        return next;
      });
      if (found || k) flash([found && `${found.bpm} BPM from the ${found.from}`, k && `key ${keyName(k)} from the video name`].filter(Boolean).join(" · "));
      else if (announce) flash("Couldn't find a BPM in the video name or description. Try Listen, or tap it.");
    },
    [update, flash]
  );
  useEffect(() => {
    if (!ready || !project || !project.videoId || project.autoBpm !== undefined) return;
    const p = project;
    const t = window.setTimeout(() => runAutoBpm(projectsRef.current.find((x) => x.id === p.id) ?? p, false), 1500);
    return () => window.clearTimeout(t);
  }, [ready, project?.id, project?.videoId, project?.autoBpm === undefined, runAutoBpm]);

  const tempoAuto = !!tempo && tempo.source === "auto";
  const autoFound = project?.autoBpm ?? null;
  const [overriding, setOverriding] = useState(false);
  useEffect(() => setOverriding(false), [project?.id]);
  const tempoLocked = tempoAuto && !overriding;
  const backToAuto = useCallback(() => {
    if (!project || !autoFound) return;
    update(project.id, (p) => ({
      ...p,
      tempo: { ...(p.tempo ?? { downbeat: 0, beatsPerBar: 4 }), bpm: autoFound.bpm, ...(autoFound.downbeat !== undefined ? { downbeat: autoFound.downbeat } : {}), source: "auto" },
    }));
    setOverriding(false);
    flash(`Back to ${autoFound.bpm} BPM from the ${autoFound.from}`);
  }, [project, autoFound, update, flash]);

  // Song key: auto (video name or listening) or set by you.
  const songKey = project?.key ?? null;
  const keyAuto = songKey?.source === "auto";
  const [keyOverriding, setKeyOverriding] = useState(false);
  useEffect(() => setKeyOverriding(false), [project?.id]);
  const keyLocked = keyAuto && !keyOverriding;
  const setKey = useCallback(
    (k: { tonic: number; mode: "major" | "minor" } | null) =>
      project && update(project.id, (p) => ({ ...p, key: k ? { ...k, source: "manual" } : undefined })),
    [project, update]
  );
  const keyBackToAuto = useCallback(() => {
    const a = project?.autoKey;
    if (!project || !a) return;
    update(project.id, (p) => ({ ...p, key: { tonic: a.tonic, mode: a.mode, source: "auto" } }));
    setKeyOverriding(false);
  }, [project, update]);

  // Listen: share this tab's audio for ~12s and work out the BPM and bar start from the sound.
  const canListen = typeof navigator !== "undefined" && !!(navigator.mediaDevices as any)?.getDisplayMedia;
  const listenForBpm = useCallback(async () => {
    if (!project || !playerRef.current) return flash("Load the beat first");
    let stream: MediaStream | null = null;
    try {
      stream = await captureTabAudio();
    } catch {
      return flash("Listening was cancelled.");
    }
    if (!stream) return flash("Pick this tab and keep “Share tab audio” switched on.");
    const p = project;
    try {
      if (!isPlaying()) playerRef.current.playVideo();
      const res = await detectFromStream(
        stream,
        12,
        (ctxTime, ctx) => estimateNow() - (ctx.currentTime - ctxTime),
        (pr) => setBpmBusy(`Listening… ${Math.round(pr * 100)}%`)
      );
      if (!res) return flash("Couldn't hear a clear beat. Make sure it's playing with the volume up.");
      const found = { bpm: res.bpm, from: "audio" as const, downbeat: res.downbeat };
      update(p.id, (x) => ({
        ...x,
        autoBpm: found,
        tempo: { bpm: res.bpm, downbeat: res.downbeat, beatsPerBar: 4, source: "auto" },
        ...(res.key
          ? { autoKey: { ...res.key, from: "audio" as const }, key: x.key?.source === "manual" ? x.key : { ...res.key, source: "auto" as const } }
          : {}),
      }));
      setOverriding(false);
      setKeyOverriding(false);
      flash(`Heard ${res.bpm} BPM${res.key ? `, key ${keyName(res.key)}` : ""}. Bar start set to ${fmt(res.downbeat, true)}.`);
    } finally {
      stream.getTracks().forEach((t) => t.stop());
      setBpmBusy(null);
    }
  }, [project, update, flash]);

  /* ---------- clean up duplicate sections ---------- */
  const dupGroups = useMemo(
    () => findDuplicates(markers, (id) => takes.filter((t) => t.markerId === id).length),
    [markers, takes]
  );
  const dupCount = dupGroups.reduce((n, g) => n + g.length - 1, 0);
  const cleanDuplicates = useCallback(async () => {
    if (!project || !dupGroups.length) return;
    if (!confirm(`Merge ${dupCount} duplicate section${dupCount === 1 ? "" : "s"}? Your lyrics and takes are kept on the remaining copy. (History has your current version if you need it back.)`)) return;
    await takeSnapshot(project, true);
    const remove = new Map<string, string>(); // removed id -> kept id
    for (const g of dupGroups) for (const m of g.slice(1)) remove.set(m.id, g[0].id);
    // Move takes onto the kept section.
    const moved: Take[] = [];
    setTakes((ts) =>
      ts.map((t) => {
        const to = remove.get(t.markerId);
        if (!to) return t;
        const u = { ...t, markerId: to };
        moved.push(u);
        return u;
      })
    );
    update(project.id, (p) => ({
      ...p,
      markers: p.markers
        .filter((m) => !remove.has(m.id))
        .map((m) => {
          const g = dupGroups.find((x) => x[0].id === m.id);
          if (!g) return m;
          // Fill in anything the keeper was missing from its copies.
          const lyrics = m.lyrics.trim() ? m.lyrics : g.find((x) => x.lyrics.trim())?.lyrics ?? "";
          const label = m.label || g.find((x) => x.label)?.label || "";
          const original = m.original ?? g.find((x) => x.original)?.original;
          return { ...m, lyrics, label, ...(original ? { original } : {}) };
        }),
    }));
    await sleep(0);
    await Promise.all(moved.map(saveTake));
    flash(`Merged ${dupCount} duplicate section${dupCount === 1 ? "" : "s"}`);
  }, [project, dupGroups, dupCount, takeSnapshot, update, flash]);

  /* ---------- song codes ---------- */
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteDraft, setPasteDraft] = useState("");
  const copyCode = useCallback(async () => {
    if (!project) return;
    const code = await songCode([project]);
    try {
      await navigator.clipboard.writeText(code);
      flash(`Song code copied (${code.length.toLocaleString()} characters). Paste it anywhere, then use Paste code to load it. Recordings aren't included.`);
    } catch {
      setPasteDraft(code);
      setPasteOpen(true);
      flash("Couldn't copy automatically. Select the code and copy it.");
    }
  }, [project, flash]);
  const copyLink = useCallback(async () => {
    if (!project) return;
    const code = await songCode([project]);
    const link = `${location.origin}${location.pathname}#s=${code.slice("INKBEAT1:".length)}`;
    try {
      await navigator.clipboard.writeText(link);
      flash(project.beat ? "Link copied. Your beat file isn't in the link, so they'll need to upload it." : "Link copied. Whoever opens it gets a copy of this song.");
    } catch {
      setPasteDraft(link);
      setPasteOpen(true);
      flash("Couldn't copy automatically. Select the link and copy it.");
    }
  }, [project, flash]);
  // Opening a share link: offer to add the song.
  useEffect(() => {
    if (!loaded) return;
    const take = async () => {
      const h = window.location.hash;
      if (!h.startsWith("#s=")) return;
      history.replaceState(null, "", window.location.pathname + window.location.search);
      try {
        const added = await importSongCode("INKBEAT1:" + h.slice(3), new Set(projectsRef.current.map((p) => p.id)));
        added.forEach((p) => savedRef.current.set(p.id, p));
        setProjects((ps) => [...added, ...ps]);
        if (added[0]) {
          setCurrentId(added[0].id);
          setViewState("song");
          flash(`Opened "${added[0].title}" from a shared link. It's saved in your songs.`);
        }
      } catch (e: any) {
        flash(e?.message || "That link didn't work");
      }
    };
    take();
    window.addEventListener("hashchange", take);
    return () => window.removeEventListener("hashchange", take);
  }, [loaded, flash]);
  const doPasteCode = useCallback(async () => {
    try {
      const added = await importSongCode(pasteDraft, new Set(projectsRef.current.map((p) => p.id)));
      added.forEach((p) => savedRef.current.set(p.id, p));
      setProjects((ps) => [...added, ...ps]);
      if (added[0]) switchProject(added[0].id);
      setPasteOpen(false);
      setPasteDraft("");
      flash(`Added ${added.length === 1 ? `"${added[0].title}"` : `${added.length} songs`}`);
    } catch (e: any) {
      flash(e?.message || "That code didn't work");
    }
  }, [pasteDraft, switchProject, flash]);

  /* ---------- keyboard ---------- */
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && viewRef.current !== "home" && !performingRef.current) {
        e.preventDefault();
        dropAtPlayhead();
        return;
      }
      if (e.key === "Escape") {
        if (typing) target.blur();
        if (rec) finishRecording();
        if (punchRef.current) stopPunch();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || viewRef.current === "home") return;
      if (compareRef.current && (e.key === "Tab" || e.key === "a" || e.key === "A" || e.key === "b" || e.key === "B")) {
        e.preventDefault();
        flipCompare(e.key === "Tab" ? undefined : (e.key.toLowerCase() as "a" | "b"));
        return;
      }
      if (compareRef.current && e.key === " ") {
        e.preventDefault();
        playCompare();
        return;
      }
      if (performingRef.current && e.key !== " ") return;
      if ((e.key === "p" || e.key === "P") && punchRef.current) {
        e.preventDefault();
        if (punchRef.current.punchIn === null) punchIn();
        else stopPunch();
        return;
      }
      if (e.key === " ") {
        e.preventDefault();
        if (punchRef.current) stopPunch();
        else if (rec) finishRecording();
        else togglePlay();
      } else if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        dropAtPlayhead();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seek(estimateNow() - 5);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seek(estimateNow() + 5);
      } else if (e.key === "r" || e.key === "R") {
        const m = activeId ? markers.find((x) => x.id === activeId) : markers[0];
        if (m) startRecording(m);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dropAtPlayhead, togglePlay, seek, rec, finishRecording, startRecording, activeId, markers, flipCompare, playCompare]);

  const addTyped = () => {
    const t = parseTime(stampDraft);
    if (t === null) return flash('Type a time like 1:23 or 83');
    addMarker(t);
    setStampDraft("");
  };

  if (!loaded)
    return (
      <div className="boot">
        <span>Inkbeat</span>
        {bootIssue === "blocked" && (
          <p className="boot-msg">
            Inkbeat is open in another tab or window with an older version. Close the other Inkbeat tabs and this will finish
            loading by itself.
          </p>
        )}
        {bootIssue === "slow" && (
          <>
            <p className="boot-msg">
              Still loading your songs… If this doesn't finish, close any other Inkbeat tabs and reload (Ctrl/⌘ + Shift + R).
            </p>
            <BootDiagnostics />
          </>
        )}
        {bootIssue === "error" && (
          <p className="boot-msg">
            Couldn't open your saved songs. Private/incognito windows and some browser settings block storage. Try a normal
            window, then reload.
          </p>
        )}
      </div>
    );

  return (
    <div className={`app ${drawer && view === "song" ? "with-drawer" : ""}`}>
      <aside className={`rail ${navOpen ? "open" : ""}`}>
        <button
          className={`brand ${view === "home" ? "here" : ""}`}
          onClick={() => {
            if (rec) finishRecording();
            stopTake();
            playerRef.current?.pauseVideo();
            setNavOpen(false);
            setView("home");
          }}
          title="Home"
        >
          <img className="brand-mark" src={logo} alt="" width={30} height={30} />
          Inkbeat
        </button>
        <button className="new-song" onClick={createProject}>
          + New song
        </button>
        <nav className="songs" aria-label="Songs">
          {projects.map((p) => (
            <div key={p.id} className={`song ${p.id === currentId && view === "song" ? "current" : ""}`}>
              <button className="song-open" onClick={() => switchProject(p.id)}>
                <span className="song-title" {...marquee}>{p.title || "Untitled song"}</span>
                <span className="song-meta">
                  {p.markers.length} marker{p.markers.length === 1 ? "" : "s"}
                  {hasBeat(p) ? "" : " · no beat"}
                </span>
              </button>
              <button className="song-del" title="Delete song" aria-label={`Delete ${p.title}`} onClick={() => removeProject(p)}>
                ×
              </button>
            </div>
          ))}
        </nav>
        <div className="settings">
          <span className="backup-lbl">Settings</span>
          <Switch
            on={prefs.splash}
            onChange={(v) => setPrefs((p) => ({ ...p, splash: v }))}
            label="Startup animation"
            title="Play the record animation when the site opens"
          />
          <Switch
            on={prefs.pitch}
            onChange={(v) => setPrefs((p) => ({ ...p, pitch: v }))}
            label="Pitch line"
            title="While recording, show the note you're singing against the song's key"
          />
          {!standalone && installEvt && (
            <button
              className="install-btn"
              onClick={async () => {
                installEvt.prompt();
                await installEvt.userChoice.catch(() => {});
                setInstallEvt(null);
              }}
            >
              Install app
            </button>
          )}
          {!standalone && !installEvt && isIOS && (
            <p className="install-hint">
              Install on iPhone: tap <b>Share</b>, then <b>Add to Home Screen</b>.
            </p>
          )}
        </div>
        <div className="backup">
          <span className="backup-lbl">Backup</span>
          <div className="backup-grid">
            <button onClick={() => doExport(false)} disabled={busyBackup || !project} title="Download this song with its lyrics and takes">
              Export song
            </button>
            <button onClick={() => doExport(true)} disabled={busyBackup} title="Download every song with lyrics and takes">
              Export all
            </button>
            <button onClick={() => fileRef.current?.click()} disabled={busyBackup} title="Add songs from an Inkbeat backup file">
              Import
            </button>
            <button onClick={() => project && exportLyricsText(project)} disabled={!project} title="Download this song's lyrics as a text file">
              Lyrics .txt
            </button>
            <button onClick={copyCode} disabled={!project} title="Copy this song as a code you can paste anywhere (lyrics, timing, links; no recordings)">
              Copy code
            </button>
            <button onClick={() => setPasteOpen(true)} title="Paste a song code to add that song">
              Paste code
            </button>
            <button onClick={copyLink} disabled={!project} title="Copy a link that opens this song for whoever clicks it (lyrics, timing, links; no recordings or beat files)">
              Share link
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])}
          />
        </div>
        <div className="rail-foot">
          Saved in this browser. Export to move songs to another device.
          <br />
          Use headphones when recording.
        </div>
      </aside>

      {view === "home" && (
        <main className="main home-main">
          <button className="nav-toggle home-nav" onClick={() => setNavOpen((v) => !v)} aria-label="Songs">
            ☰
          </button>
          <Home
            currentTitle={project?.title ?? null}
            songCount={projects.filter((p) => hasBeat(p) || p.markers.length).length}
            onOpen={() => setView("song")}
            onNew={createProject}
          />
        </main>
      )}
      <main className="main" style={view === "home" ? { display: "none" } : undefined}>
        {project && (
          <>
            <header className="topbar">
              <button className="nav-toggle" onClick={() => setNavOpen((v) => !v)} aria-label="Songs">
                ☰
              </button>
              <input
                className="title-input"
                {...marquee}
                value={project.title}
                onChange={(e) => update(project.id, (p) => ({ ...p, title: e.target.value }))}
                aria-label="Song title"
                spellCheck={false}
              />
              {songTakes.length > 0 && (
                <button
                  className={`song-play ${songMode ? "on" : ""}`}
                  onClick={playSong}
                  title="Play the beat with your keeper take for every section"
                >
                  <span className="song-play-icon" aria-hidden>
                    {songMode ? "■" : "▶"}
                  </span>
                  {songMode ? "Stop song" : "Play song"}
                  <small>
                    {songTakes.length} take{songTakes.length === 1 ? "" : "s"}
                  </small>
                </button>
              )}
              {songTakes.length > 0 && (
                <button className="export-vox" onClick={() => exportVocals(false)} disabled={exporting} title="Mix your keeper takes into one WAV file that lines up with the beat">
                  {exporting ? "Mixing…" : "Export vocals"}
                </button>
              )}
              {songTakes.length > 0 && project.beat && (
                <button className="export-vox mix" onClick={() => exportVocals(true)} disabled={exporting} title="Your keeper takes mixed over your beat file, as one WAV">
                  {exporting ? "Mixing…" : "Export full mix"}
                </button>
              )}
              {songTakes.length > 0 && (
                <Switch
                  on={takeBeat}
                  onChange={toggleTakeBeat}
                  label="with beat"
                  title="Hear the beat under your takes. Works live while takes or Play song are playing."
                />
              )}
              <button className="perform-btn" onClick={() => setPerforming(true)} disabled={!markers.some((m) => m.lyrics.trim())} title="Full-screen lyrics that scroll with the beat">
                Perform
              </button>
              <div className="tool-btns">
                {(
                  [
                    ["notes", "Notes"],
                    ["rhymes", "Rhymes"],
                    ["history", "History"],
                    ["spark", "Stuck?"],
                  ] as const
                ).map(([k, label]) => (
                  <button key={k} className={drawer === k ? "on" : ""} onClick={() => toggleDrawer(k)} aria-pressed={drawer === k}>
                    {label}
                  </button>
                ))}
              </div>
              {hasBeat(project) && (
                <div className="beat-swap">
                  {project.beat ? (
                    <span className="beat-name" title={project.beat.name}>
                      ♪ {project.beat.name}
                    </span>
                  ) : null}
                  <button onClick={() => beatInputRef.current?.click()} title="Use an audio file from your computer as the beat">
                    {project.beat ? "Swap file" : "Upload beat file"}
                  </button>
                  {project.beat && (
                    <button onClick={removeBeatFile} className="danger" title="Remove the beat file from this song">
                      Remove
                    </button>
                  )}
                </div>
              )}
              {hasBeat(project) && (
                <form
                  className="relink"
                  onSubmit={(e) => {
                    e.preventDefault();
                    linkVideo(linkDraft);
                  }}
                >
                  <input
                    value={linkDraft}
                    onChange={(e) => setLinkDraft(e.target.value)}
                    placeholder={project.beat ? "Or use a YouTube link instead" : "Swap video: paste a YouTube link"}
                    aria-label="Swap YouTube link"
                  />
                </form>
              )}
            </header>

            <section className="deck">
              <div
                className={`screen ${dragOver ? "drag" : ""} ${project.beat && !usingBacking ? "file" : ""}`}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes("Files")) {
                    e.preventDefault();
                    setDragOver(true);
                  }
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) loadBeatFile(f);
                }}
              >
                <div ref={hostRef} className="yt-host" />
                {project.beat && !usingBacking && <BeatWave peaks={beatPeaks} name={project.beat.name} />}
                {beatBusy && <div className="beat-busy">{beatBusy}</div>}
                {dragOver && <div className="drop-hint">Drop the beat file</div>}
                {hasBeat(project) && playerError && (
                  <div className="player-error" role="alert">
                    <p>{playerError}</p>
                    {project.videoId ? (
                      <a href={`https://www.youtube.com/watch?v=${project.videoId}`} target="_blank" rel="noreferrer">
                        Open on YouTube
                      </a>
                    ) : (
                      <button onClick={() => beatInputRef.current?.click()}>Upload the file again</button>
                    )}
                  </div>
                )}
                <input
                  ref={beatInputRef}
                  type="file"
                  accept={BEAT_TYPES}
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) loadBeatFile(f);
                  }}
                />
                {!hasBeat(project) && (
                  <form
                    className="paste"
                    onSubmit={(e) => {
                      e.preventDefault();
                      linkVideo(linkDraft);
                    }}
                  >
                    <label htmlFor="link">Drop a beat or song</label>
                    <p>Paste a YouTube link: a beat to write over, or a song to cover or parody.</p>
                    <div className="paste-row">
                      <input
                        id="link"
                        autoFocus
                        value={linkDraft}
                        onChange={(e) => setLinkDraft(e.target.value)}
                        placeholder="https://youtube.com/watch?v=…"
                      />
                      <button type="submit">Load</button>
                    </div>
                    <div className="paste-or">
                      <span>or</span>
                      <button type="button" className="upload-btn" onClick={() => beatInputRef.current?.click()}>
                        Upload a beat file
                      </button>
                      <small>MP3, WAV, M4A… or drag it here. Lets you export the full mix, and BPM/key are found straight from the file.</small>
                    </div>
                  </form>
                )}
              </div>

              <div className="transport">
                <Readout />
                <div className="t-row">
                  <button className="t-btn" onClick={() => seek(estimateNow() - 5)} disabled={!ready} title="Back 5s (←)">
                    −5
                  </button>
                  <PlayButton onClick={() => (rec ? finishRecording() : togglePlay())} disabled={!ready} />
                  <button className="t-btn" onClick={() => seek(estimateNow() + 5)} disabled={!ready} title="Forward 5s (→)">
                    +5
                  </button>
                </div>
                <button className="drop" onClick={dropAtPlayhead} disabled={!ready || !hasBeat(project)}>
                  Drop marker <kbd>M</kbd>
                </button>
                <form
                  className="stamp"
                  onSubmit={(e) => {
                    e.preventDefault();
                    addTyped();
                  }}
                >
                  <input
                    value={stampDraft}
                    onChange={(e) => setStampDraft(e.target.value)}
                    placeholder="or type 1:23"
                    aria-label="Add marker at time"
                  />
                  <button type="submit">Add</button>
                </form>
                <div className="tempo-box">
                  <div className="tempo-head">
                    <span className="tempo-title">Tempo</span>
                    {tempo ? (
                      <span className={`tempo-mode ${tempoAuto ? "auto" : "manual"}`}>
                        {tempoAuto ? `Auto · from ${autoFound?.from ?? "video name"}` : "Manual"}
                      </span>
                    ) : (
                      <span className="tempo-sub">for the metronome &amp; bar lines</span>
                    )}
                    {tempoLocked ? (
                      <button className="tempo-act" onClick={() => setOverriding(true)} title="Set your own BPM instead of the one in the title">
                        Override
                      </button>
                    ) : tempo && !tempoAuto && autoFound ? (
                      <button className="tempo-act" onClick={backToAuto} title={`Use ${autoFound.bpm} BPM from the ${autoFound.from} again`}>
                        Back to auto ({autoFound.bpm})
                      </button>
                    ) : null}
                  </div>
                  <div className={`tempo ${tempoLocked ? "locked" : ""}`} title={tempoLocked ? "Using the BPM from the title. Press Override to change it." : undefined}>
                    <Stepper
                      label="Tempo"
                      disabled={tempoLocked}
                      title="Beats per minute. Click the number to clear it."
                      value={tempo?.bpm ?? 0}
                      step={1}
                      format={(v) => (v ? `${v} BPM` : "– BPM")}
                      onChange={(v) => setTempo(v > 0 ? { bpm: tempo ? v : Math.max(v, 60) } : null)}
                    />
                    <div className="halfdouble">
                      <button
                        onClick={() => tempo && setTempo({ bpm: tempo.bpm / 2 })}
                        disabled={tempoLocked || !tempo}
                        title="Half speed (if the BPM came out double)"
                      >
                        ½
                      </button>
                      <button
                        onClick={() => tempo && setTempo({ bpm: tempo.bpm * 2 })}
                        disabled={tempoLocked || !tempo}
                        title="Double speed (common with trap beats read at half time)"
                      >
                        ×2
                      </button>
                    </div>
                    <button className="tap" onClick={tapTempo} disabled={tempoLocked} title="Tap along with the beat to measure its BPM">
                      {tapCount > 0 ? `Tap ${tapCount}` : "Tap tempo"}
                    </button>
                  </div>
                  <button
                    className="bar-start"
                    onClick={() => setTempo({ downbeat: Math.round(estimateNow() * 1000) / 1000, ...(tempo ? {} : { bpm: 90 }) })}
                    disabled={!ready}
                    title="Pause on a strong '1' (like where the drums hit) and press this"
                  >
                    Set bar start here <span>{fmt(Math.max(0, tempo?.downbeat ?? 0), true)}</span>
                  </button>
                  <div className="key-row">
                    <span className="tempo-title">Key</span>
                    {songKey && (
                      <span className={`tempo-mode ${keyAuto ? "auto" : "manual"}`}>
                        {keyAuto ? `Auto · from ${project.autoKey?.from ?? "video name"}` : "Manual"}
                      </span>
                    )}
                    <KeyPicker
                      value={songKey}
                      label={songKey ? keyName(songKey) : "Set key"}
                      disabled={keyLocked}
                      onChange={setKey}
                    />
                    {keyLocked ? (
                      <button className="tempo-act" onClick={() => setKeyOverriding(true)}>
                        Override
                      </button>
                    ) : songKey && !keyAuto && project.autoKey ? (
                      <button className="tempo-act" onClick={keyBackToAuto}>
                        Back to auto ({keyName(project.autoKey)})
                      </button>
                    ) : null}
                  </div>
                  {songKey && (
                    <p className="key-notes">
                      Notes: <b>{scaleNotes(songKey).join(" ")}</b> · same notes as {keyName(relative(songKey))}
                    </p>
                  )}
                  <div className="tempo-find">
                    <button onClick={() => project && (project.beat ? reanalyzeBeat() : runAutoBpm(project, true))} disabled={!!bpmBusy || !!beatBusy || !hasBeat(project)} title="Check the video name, the description, and (for covers) a song database">
                      Find BPM &amp; key
                    </button>
                    {canListen && !project.beat && (
                      <button onClick={listenForBpm} disabled={!!bpmBusy || !ready} title="Listen to the beat for 12 seconds and work out the BPM from the sound (Chrome: pick this tab and share its audio)">
                        Listen
                      </button>
                    )}
                    {bpmBusy && <span className="tempo-busy">{bpmBusy}</span>}
                  </div>
                  <div className="tempo-metro">
                    <Switch
                      on={prefs.metronome}
                      onChange={(v) => {
                        metronome.unlock();
                        setPrefs((p) => ({ ...p, metronome: v }));
                        if (v && !tempo) flash("Set a BPM first: type it, tap along, or put it in the title");
                      }}
                      label="Metronome"
                      title="Click track while the beat plays"
                    />
                  </div>
                  <p className="tempo-hint">
                    {tempoLocked
                      ? autoFound?.from === "audio"
                        ? "BPM and bar start worked out by listening. Press Override to tap or type your own."
                        : `Using the BPM from the ${autoFound?.from ?? "video name"}. Press Override to tap or type your own.`
                      : tapCount > 0 && tapCount < 3
                      ? "Keep tapping on every beat…"
                      : tapCount >= 3
                        ? `Got it: ${tempo?.bpm ?? "…"} BPM. Tap more to fine-tune.`
                        : !tempo
                          ? "Press Find BPM or Listen, or tap along / type it yourself."
                          : "Then pause right on a “1” (where a bar starts) and press Set bar start here."}
                  </p>
                </div>
                <button className="cover-btn" onClick={() => setCoverOpen(true)} disabled={!hasBeat(project)}>
                  Cover / parody <small>pull lyrics</small>
                </button>
                <div className="prefs">
                  <div className="pref">
                    <span className="pref-lbl">Lead-in</span>
                    <Segmented
                      label="Lead-in before the marker when recording"
                      value={prefs.leadIn}
                      options={[
                        { value: 0, label: "0" },
                        { value: 2, label: "2s" },
                        { value: 4, label: "4s" },
                        { value: 8, label: "8s" },
                      ]}
                      onChange={(v) => setPrefs((p) => ({ ...p, leadIn: v }))}
                    />
                  </div>
                  <div className="pref">
                    <span className="pref-lbl">Sync</span>
                    <Stepper
                      label="Take sync"
                      title="If your takes sound early or late against the beat, shift them here"
                      value={prefs.nudgeMs}
                      step={10}
                      format={(v) => `${v > 0 ? "+" : ""}${v}ms`}
                      onChange={(v) => setPrefs((p) => ({ ...p, nudgeMs: v }))}
                    />
                  </div>
                  <div className="pref-row">

                    <Switch on={prefs.countIn} onChange={(v) => setPrefs((p) => ({ ...p, countIn: v }))} label="Count-in" title="Four clicks before recording starts" />
                    <Switch on={prefs.snap} onChange={(v) => setPrefs((p) => ({ ...p, snap: v }))} label="Snap" title="New and dragged markers land on the nearest beat (needs a BPM)" />
                    <Switch on={prefs.follow} onChange={(v) => setPrefs((p) => ({ ...p, follow: v }))} label="Follow" title="Scroll to the section that's playing" />
                    <Switch
                      on={prefs.showMeter}
                      onChange={(v) => setPrefs((p) => ({ ...p, showMeter: v }))}
                      label="Rhymes"
                      title="Color rhyming line endings and count syllables"
                    />
                  </div>
                </div>
              </div>
            </section>

            {hasBeat(project) && (
              <Timeline
                peaks={beatPeaks}
                markers={markers}
                takes={takes}
                activeId={activeId}
                onSeek={(t) => seek(t)}
                onMoveMarker={(id, t) => moveMarker(id, prefs.snap && tempo ? snapToBeat(t, tempo) : t)}
                tempo={tempo}
                recMarkerId={rec?.markerId ?? null}
                loop={loop}
              />
            )}

            {project.cover && (
              <div className="cover-bar">
                <span className="cover-what">
                  Cover of <b>{project.cover.track}</b> · {project.cover.artist}
                </span>
                <span className="cover-tools">
                  <span className="cover-lbl">Timing</span>
                  <button onClick={() => shiftCover(-0.5)} title="Original lines 0.5s earlier">−0.5s</button>
                  <button onClick={() => shiftCover(0.5)} title="Original lines 0.5s later">+0.5s</button>
                  <Switch
                    on={project.cover.showOriginal}
                    onChange={(v) => update(project.id, (p) => ({ ...p, cover: p.cover && { ...p.cover, showOriginal: v } }))}
                    label="Show original"
                  />
                  <button className="cover-remove" onClick={removeCover}>Remove</button>
                </span>
                <div className="karaoke">
                  <span className="karaoke-lbl">Karaoke</span>
                  {project.backing ? (
                    <>
                      <Segmented
                        label="Which video plays"
                        value={project.source === "backing" ? "backing" : "main"}
                        options={[
                          { value: "main", label: "Original" },
                          { value: "backing", label: "Karaoke" },
                        ]}
                        onChange={setSource}
                      />
                      <span className="cover-lbl">Karaoke timing</span>
                      <Stepper
                        label="Karaoke timing"
                        title="If the karaoke version has a longer intro, push this up until the lines match"
                        value={project.backing.offset}
                        step={0.25}
                        format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(2)}s`}
                        onChange={setBackingOffset}
                      />
                      <button className="cover-remove" onClick={removeBacking}>
                        Remove
                      </button>
                    </>
                  ) : (
                    <form
                      className="karaoke-add"
                      onSubmit={(e) => {
                        e.preventDefault();
                        linkBacking();
                      }}
                    >
                      <a className="karaoke-find" href={karaokeSearchUrl} target="_blank" rel="noreferrer">
                        Find on YouTube ↗
                      </a>
                      <input
                        value={backingDraft}
                        onChange={(e) => setBackingDraft(e.target.value)}
                        placeholder="then paste the karaoke link"
                        aria-label="Karaoke YouTube link"
                      />
                      <button type="submit" disabled={!backingDraft.trim()}>
                        Add
                      </button>
                    </form>
                  )}
                </div>
              </div>
            )}

            {dupCount > 0 && (
              <div className="dup-bar" role="status">
                <span>
                  <b>{dupCount}</b> duplicate section{dupCount === 1 ? "" : "s"} (same spot, same lyrics)
                </span>
                <button onClick={cleanDuplicates}>Clean up</button>
              </div>
            )}

            <section className="sheet" aria-label="Lyrics">
              {markers.length === 0 ? (
                <div className="sheet-empty">
                  <p className="big">Blank page.</p>
                  <p>
                    Play the beat and hit <kbd>M</kbd> wherever a verse, hook or bar should land. Each marker gets its own
                    lyrics and its own flows.
                  </p>
                </div>
              ) : (
                markers.map((m, i) => (
                  <MarkerBlock
                    key={m.id}
                    marker={m}
                    index={i}
                    nextTime={markers[i + 1]?.time}
                    active={m.id === activeId}
                    takes={takes.filter((t) => t.markerId === m.id)}
                    rec={rec?.markerId === m.id ? rec.phase : null}
                    recBusy={!!rec && rec.markerId !== m.id}
                    playingTakeId={playingTakeId}
                    autoFocus={focusMarkerId === m.id}
                    onFocused={() => setFocusMarkerId(null)}
                    onChange={(patch) => changeMarker(m.id, patch)}
                    onSeek={(play) => seek(m.time, play)}
                    onRestamp={() => {
                      const t = Math.round(estimateNow() * 10) / 10;
                      if (Math.abs(t - m.time) < 0.05) return flash("This section is already at the playhead");
                      if (!confirm(`Move "${m.label || `Section ${i + 1}`}" from ${fmt(m.time, true)} to ${fmt(t, true)}?\n\nThis changes where the section starts. To jump the video to this section instead, click its time.`)) return;
                      moveMarker(m.id, t);
                    }}
                    onDelete={() => removeMarker(m)}
                    onRecord={() => startRecording(m)}
                    onLayer={(t) => startRecording(m, t)}
                    layeringOver={rec?.markerId === m.id ? layerOver : null}
                    onFx={changeFx}
                    onCompare={() => openCompare(m)}
                    bpm={project.tempo?.bpm}
                    onPlayTake={playTake}
                    withBeat={takeBeat}
                    showOriginal={project.cover?.showOriginal ?? true}
                    onSeekTo={(t) => seek(t, true)}
                    onWithBeat={toggleTakeBeat}
                    onStopTake={() => {
                      stopTake();
                      playerRef.current?.pauseVideo();
                    }}
                    onRenameTake={renameTake}
                    onDeleteTake={removeTake}
                    onStarTake={starTake}
                    punch={punch}
                    onPunch={startPunch}
                    onPunchIn={punchIn}
                    onStopPunch={stopPunch}
                    songTakeId={songTakeIds.get(m.id) ?? null}
                    looping={loop?.markerId === m.id}
                    onLoop={() => toggleLoop(m, i)}
                    showMeter={prefs.showMeter}
                    onSelectWord={(w) => {
                      onSelectWord(w);
                    }}
                  />
                ))
              )}
            </section>

            {((rec?.phase === "recording" || punch?.phase === "recording") && prefs.pitch && micStream) && (
              <div className="pitch-dock">
                <PitchLine stream={micStream} songKey={songKey ? { tonic: songKey.tonic, mode: songKey.mode } : null} />
              </div>
            )}
            {compare && (() => {
              const cm = markers.find((x) => x.id === compare.markerId);
              const bases = takes.filter((t) => t.markerId === compare.markerId && !t.layerOf);
              const ta = bases.find((t) => t.id === compare.a);
              const tb = bases.find((t) => t.id === compare.b);
              const pickSel = (side: "a" | "b", val: string) => (
                <select
                  value={val}
                  onChange={(e) => {
                    stopCompareAudio();
                    if (compare.playing) playerRef.current?.pauseVideo();
                    setCompare({ ...compare, [side]: e.target.value, playing: false });
                  }}
                  aria-label={`Take ${side.toUpperCase()}`}
                >
                  {bases.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              );
              return (
                <div className="ab-bar" role="region" aria-label="Compare takes">
                  <div className="ab-title">
                    A/B <span>{cm?.label || (cm ? fmt(cm.time) : "")}</span>
                  </div>
                  <button className="ab-play" onClick={playCompare} aria-label={compare.playing ? "Stop" : "Play both"}>
                    {compare.playing ? "■" : "▶"}
                  </button>
                  <div className={`ab-side ${compare.side === "a" ? "on" : ""}`}>
                    <button onClick={() => flipCompare("a")} aria-pressed={compare.side === "a"}>
                      A
                    </button>
                    {pickSel("a", compare.a)}
                    <button className="ab-keep" onClick={() => ta && !ta.starred && starTake(ta)} disabled={!ta || ta.starred}>
                      {ta?.starred ? "★ keeper" : "Keep A"}
                    </button>
                  </div>
                  <button className="ab-flip" onClick={() => flipCompare()} title="Flip between A and B (Tab)">
                    ⇄ <kbd>Tab</kbd>
                  </button>
                  <div className={`ab-side ${compare.side === "b" ? "on" : ""}`}>
                    <button onClick={() => flipCompare("b")} aria-pressed={compare.side === "b"}>
                      B
                    </button>
                    {pickSel("b", compare.b)}
                    <button className="ab-keep" onClick={() => tb && !tb.starred && starTake(tb)} disabled={!tb || tb.starred}>
                      {tb?.starred ? "★ keeper" : "Keep B"}
                    </button>
                  </div>
                  <button className="ab-x" onClick={closeCompare} aria-label="Close compare">
                    ×
                  </button>
                </div>
              );
            })()}

            <footer className="keys">
              <span>
                <kbd>Space</kbd> play/pause
              </span>
              <span>
                <kbd>M</kbd> marker
              </span>
              <span>
                <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> marker while typing
              </span>
              <span>
                <kbd>R</kbd> record current
              </span>
              <span>
                <kbd>←</kbd>
                <kbd>→</kbd> 5s
              </span>
              <span>
                <kbd>Esc</kbd> stop / leave text
              </span>
            </footer>
          </>
        )}
      </main>

      {drawer && project && view === "song" && (
        <Drawer
          tab={drawer}
          onTab={setDrawer}
          onClose={() => setDrawer(null)}
          project={project}
          onNotes={(v) => update(project.id, (p) => ({ ...p, notes: v }))}
          word={rhymeWord}
          onWord={setRhymeWord}
          onRestore={restoreSnapshot}
          historyKey={historyKey}
          flash={flash}
        />
      )}

      {pasteOpen && (
        <div className="paste-code" role="dialog" aria-label="Paste a song code" onMouseDown={(e) => e.target === e.currentTarget && setPasteOpen(false)}>
          <div className="paste-card">
            <h3>Song code</h3>
            <p>Paste a code that starts with INKBEAT1: and press Add song. Codes carry lyrics, sections, timing and video links (no recordings).</p>
            <textarea value={pasteDraft} onChange={(e) => setPasteDraft(e.target.value)} placeholder="INKBEAT1:…" autoFocus spellCheck={false} />
            <div className="paste-actions">
              <button onClick={() => setPasteOpen(false)}>Cancel</button>
              <button className="go" onClick={doPasteCode} disabled={!pasteDraft.trim()}>
                Add song
              </button>
            </div>
          </div>
        </div>
      )}

      {performing && project && (
        <Perform
          title={project.title}
          markers={markers}
          duration={playerRef.current?.getDuration() ? playerRef.current.getDuration() - getOffset() : 0}
          onTogglePlay={togglePlay}
          onSeek={(t) => seek(t, true)}
          onClose={() => setPerforming(false)}
        />
      )}

      {coverOpen && project && (
        <CoverDialog
          initialQuery={project.title === "Untitled song" ? "" : project.title}
          videoDuration={playerRef.current?.getDuration() || 0}
          onImport={importCover}
          onClose={() => setCoverOpen(false)}
        />
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

/** What shows in the screen for a beat file: big waveform with a moving playhead. */
function BeatWave({ peaks, name }: { peaks: Float32Array | null; name: string }) {
  const head = useClock((s) => (s.duration ? Math.round((s.now / s.duration) * 1000) / 10 : 0));
  return (
    <div className="beatwave">
      <div className="beatwave-name">♪ {name}</div>
      <div className="beatwave-wave">
        {peaks ? <Wave peaks={peaks} className="bigwave" /> : <span className="beatwave-wait">drawing waveform…</span>}
        <div className="beatwave-played" style={{ width: `${head}%` }} />
        <div className="beatwave-head" style={{ left: `${head}%` }} />
      </div>
    </div>
  );
}

function Readout() {
  const now = useClock((s) => Math.floor(s.now * 10));
  const dur = useClock((s) => Math.floor(s.duration));
  return (
    <div className="readout" aria-label="Playback time">
      <span className="now">{fmt(now / 10, true)}</span>
      <span className="dur">/ {fmt(dur)}</span>
      <BeatLight />
    </div>
  );
}

function PlayButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  const playing = useClock((s) => s.playing);
  return (
    <button className="t-play" onClick={onClick} disabled={disabled} aria-label={playing ? "Pause" : "Play"} title="Space">
      {playing ? (
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
          <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
          <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
          <path d="M7 4.5v15l13-7.5z" fill="currentColor" />
        </svg>
      )}
    </button>
  );
}

/** Blinks on each metronome click; the first beat of a bar is red. */
function BeatLight() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    metronome.onBeat((b) => {
      const el = ref.current;
      if (!el) return;
      el.classList.toggle("one", b === 0);
      el.animate([{ opacity: 1, transform: "scale(1.25)" }, { opacity: 0.15, transform: "scale(1)" }], { duration: 220, easing: "ease-out" });
    });
    return () => metronome.onBeat(null);
  }, []);
  return <span ref={ref} className="beat-light" aria-hidden />;
}

/** Shown when loading hangs: checks storage directly so we can see where it's stuck. */
function BootDiagnostics() {
  const [lines, setLines] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const run = useCallback(async () => {
    const out: string[] = [`page: ${location.href}`, `browser: ${navigator.userAgent}`];
    out.push(`indexedDB: ${typeof indexedDB === "undefined" ? "missing" : "present"}`);
    try {
      const dbs = await (indexedDB as any).databases?.();
      out.push(`databases: ${dbs ? JSON.stringify(dbs.map((d: any) => `${d.name}@v${d.version}`)) : "n/a"}`);
    } catch (e: any) {
      out.push(`databases: error ${e?.name || e}`);
    }
    try {
      const est = await navigator.storage?.estimate?.();
      if (est) out.push(`storage: ${Math.round((est.usage || 0) / 1024)} KB used of ${Math.round((est.quota || 0) / 1048576)} MB`);
    } catch {}
    // Try a fresh open with a timeout to see what happens.
    const res = await new Promise<string>((resolve) => {
      const t = setTimeout(() => resolve("open: still pending after 5s"), 5000);
      try {
        const r = indexedDB.open("inkbeat");
        r.onblocked = () => resolve("open: BLOCKED by another tab");
        r.onerror = () => {
          clearTimeout(t);
          resolve(`open: error ${r.error?.name}: ${r.error?.message}`);
        };
        r.onsuccess = () => {
          clearTimeout(t);
          const db = r.result;
          resolve(`open: ok v${db.version}, stores ${JSON.stringify([...db.objectStoreNames])}`);
          db.close();
        };
      } catch (e: any) {
        clearTimeout(t);
        resolve(`open: threw ${e?.name}: ${e?.message}`);
      }
    });
    out.push(res);
    setLines(out);
  }, []);
  useEffect(() => {
    run();
  }, [run]);
  return (
    <div className="boot-diag">
      <div className="boot-diag-btns">
        <button onClick={() => location.reload()}>Try again</button>
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(lines.join("\n"));
              setCopied(true);
            } catch {}
          }}
          disabled={!lines.length}
        >
          {copied ? "Copied" : "Copy details"}
        </button>
      </div>
      <pre>{lines.length ? lines.join("\n") : "Checking storage…"}</pre>
    </div>
  );
}

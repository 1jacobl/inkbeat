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
} from "./db";
import { YTPlayer, loadYouTubeAPI, parseStartParam, parseVideoId } from "./youtube";
import { attachPlayer, estimateNow, getOffset, isPlaying, noteSeek, setOffset, useClock } from "./clock";
import { Segmented, Stepper, Switch } from "./ui";
import logo from "./logo.svg";
import Home from "./Home";
import { exportBackup, exportLyricsText, importBackup } from "./backup";
import { fmt, parseTime, uid } from "./time";
import Timeline from "./Timeline";
import MarkerBlock from "./MarkerBlock";
import CoverDialog from "./CoverDialog";
import type { LyricHit } from "./lyrics";

const LAST_KEY = "inkbeat:last";
const PREFS_KEY = "inkbeat:prefs";

interface Prefs {
  leadIn: number; // seconds of beat before the marker when recording
  nudgeMs: number; // shifts takes against the beat on playback
  follow: boolean; // auto-scroll the sheet to the active marker
  showMeter: boolean; // syllable counts + rhyme colors
}

function loadPrefs(): Prefs {
  const d: Prefs = { leadIn: 0, nudgeMs: 0, follow: true, showMeter: true };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") };
  } catch {
    return d;
  }
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
  useEffect(() => {
    (async () => {
      const ps = await initialProjects();
      ps.forEach((p) => savedRef.current.set(p.id, p));
      setProjects(ps);
      const last = localStorage.getItem(LAST_KEY);
      setCurrentId(ps.find((p) => p.id === last)?.id ?? ps[0].id);
      if (!ps.some((p) => p.videoId || p.markers.length)) setViewState("home");
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
  const videoId = (usingBacking ? project!.backing!.videoId : project?.videoId) || "";
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
    addMarker(estimateNow());
  }, [addMarker, flash]);

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

  const stopTake = useCallback(() => {
    playTokenRef.current++;
    const a = audioRef.current;
    if (a) {
      a.audio.pause();
      URL.revokeObjectURL(a.url);
      audioRef.current = null;
      setBeatMuted(false);
    }
    setPlayingTakeId(null);
  }, [setBeatMuted]);

  const toggleTakeBeat = useCallback(
    (on: boolean) => {
      setTakeBeat(on);
      if (audioRef.current || songModeRef.current) setBeatMuted(!on);
    },
    [setBeatMuted]
  );

  const playTake = useCallback(
    async (take: Take) => {
      stopTake();
      if (rec) return;
      const token = ++playTokenRef.current;
      const alive = () => playTokenRef.current === token;
      const url = URL.createObjectURL(take.blob);
      const audio = new Audio(url);
      audio.preload = "auto";
      audioRef.current = { audio, url, takeId: take.id };
      setPlayingTakeId(take.id);
      audio.onended = () => {
        if (!alive()) return;
        playerRef.current?.pauseVideo();
        stopTake();
      };

      if (!playerRef.current) {
        await audio.play().catch(() => {});
        return;
      }
      setBeatMuted(!takeBeatRef.current);
      const ok = await rollFrom(take.start, alive);
      if (!ok || !alive()) {
        if (alive()) {
          flash("Couldn't start the beat");
          stopTake();
        }
        return;
      }
      const offset = estimateNow() - take.start + prefs.nudgeMs / 1000;
      if (offset >= 0) {
        audio.currentTime = offset;
        await audio.play().catch(() => {});
      } else {
        await sleep(-offset * 1000);
        if (alive()) await audio.play().catch(() => {});
      }
    },
    [rec, rollFrom, stopTake, setBeatMuted, prefs.nudgeMs, flash]
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
    return s;
  }, []);

  const finishRecording = useCallback(() => {
    const r = recorderRef.current;
    recTokenRef.current++;
    if (r && r.recorder.state !== "inactive") r.recorder.stop();
    else {
      recorderRef.current = null;
      setRec(null);
    }
    playerRef.current?.pauseVideo();
  }, []);

  const startRecording = useCallback(
    async (m: Marker) => {
      if (!project || !playerRef.current) return flash("Load a beat first");
      if (rec) return finishRecording();
      stopTake();
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
        if (!info || !chunks.length) return;
        const duration = (performance.now() - info.t0) / 1000;
        if (duration < 0.4) return;
        const blob = new Blob(chunks, { type: recorder.mimeType || mime || "audio/webm" });
        const existing = takesRef.current.filter((t) => t.markerId === info.markerId).length;
        const take: Take = {
          id: uid(),
          projectId,
          markerId: info.markerId,
          name: `Take ${existing + 1}`,
          start: info.startBeat,
          duration,
          mime: blob.type,
          blob,
          createdAt: Date.now(),
        };
        await saveTake(take);
        setTakes((ts) => [...ts, take]);
      };

      // Start the mic first so nothing at the marker gets clipped, then roll the beat.
      // Once the beat is steady, work out which beat time lines up with the take's first sample.
      const target = Math.max(0, m.time - prefs.leadIn);
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
          playerRef.current?.pauseVideo();
          flash("Couldn't start the beat");
        }
        return;
      }
      setRec({ markerId: m.id, phase: "recording" });
      await sleep(400);
      if (recorderRef.current?.recorder === recorder && isPlaying()) {
        recorderRef.current.startBeat = Math.round((estimateNow() - (performance.now() - t0) / 1000) * 1000) / 1000;
      }
    },
    [project, rec, finishRecording, stopTake, getStream, rollFrom, prefs.leadIn, flash]
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

  const renameTake = useCallback(async (take: Take, name: string) => {
    const next = { ...take, name };
    setTakes((ts) => ts.map((t) => (t.id === take.id ? next : t)));
    await saveTake(next);
  }, []);

  const removeTake = useCallback(
    async (take: Take) => {
      if (!confirm(`Delete "${take.name}"?`)) return;
      if (playingTakeId === take.id) stopTake();
      await deleteTake(take.id);
      setTakes((ts) => ts.filter((t) => t.id !== take.id));
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
      update(project.id, (p) => ({ ...p, url: raw.trim(), videoId: id }));
      setLinkDraft("");
      const start = parseStartParam(raw);
      if (start) setTimeout(() => seek(start), 1500);
    },
    [project, update, flash, seek]
  );

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
      update(project.id, (p) => ({
        ...p,
        markers: [...p.markers, ...imported].sort((a, b) => a.time - b.time),
        cover: { track: hit.track, artist: hit.artist, showOriginal: true },
      }));
      setCoverOpen(false);
      flash(`Imported ${imported.length} sections`);
    },
    [project, update, flash]
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
      if (!markers.some((m) => m.id === t.markerId)) continue;
      const cur = byMarker.get(t.markerId);
      if (!cur || (t.starred && !cur.starred) || (!cur.starred && t.createdAt > cur.createdAt)) byMarker.set(t.markerId, t);
    }
    return [...byMarker.values()].sort((a, b) => a.start - b.start);
  }, [takes, markers]);
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
      const live = new Set(songTakes.map((x) => x.id));
      for (const [id, a] of songAudios.current) {
        if (!live.has(id)) {
          a.audio.pause();
          URL.revokeObjectURL(a.url);
          songAudios.current.delete(id);
        }
      }
      for (const take of songTakes) {
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
  }, [songMode, songTakes, prefs.nudgeMs]);
  useEffect(() => {
    if (rec || playingTakeId) stopSong();
  }, [rec, playingTakeId, stopSong]);
  useEffect(() => stopSong, [currentId, stopSong]);

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

  /* ---------- keyboard ---------- */
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable;
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && viewRef.current !== "home") {
        e.preventDefault();
        dropAtPlayhead();
        return;
      }
      if (e.key === "Escape") {
        if (typing) target.blur();
        if (rec) finishRecording();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || viewRef.current === "home") return;
      if (e.key === " ") {
        e.preventDefault();
        if (rec) finishRecording();
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
  }, [dropAtPlayhead, togglePlay, seek, rec, finishRecording, startRecording, activeId, markers]);

  const addTyped = () => {
    const t = parseTime(stampDraft);
    if (t === null) return flash('Type a time like 1:23 or 83');
    addMarker(t);
    setStampDraft("");
  };

  if (!loaded) return <div className="boot">Inkbeat</div>;

  return (
    <div className="app">
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
                <span className="song-title">{p.title || "Untitled song"}</span>
                <span className="song-meta">
                  {p.markers.length} marker{p.markers.length === 1 ? "" : "s"}
                  {p.videoId ? "" : " · no beat"}
                </span>
              </button>
              <button className="song-del" title="Delete song" aria-label={`Delete ${p.title}`} onClick={() => removeProject(p)}>
                ×
              </button>
            </div>
          ))}
        </nav>
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
            songCount={projects.filter((p) => p.videoId || p.markers.length).length}
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
                <Switch
                  on={takeBeat}
                  onChange={toggleTakeBeat}
                  label="with beat"
                  title="Hear the beat under your takes. Works live while takes or Play song are playing."
                />
              )}
              {project.videoId && (
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
                    placeholder="Swap video: paste a YouTube link"
                    aria-label="Swap YouTube link"
                  />
                </form>
              )}
            </header>

            <section className="deck">
              <div className="screen">
                <div ref={hostRef} className="yt-host" />
                {project.videoId && playerError && (
                  <div className="player-error" role="alert">
                    <p>{playerError}</p>
                    <a href={`https://www.youtube.com/watch?v=${project.videoId}`} target="_blank" rel="noreferrer">
                      Open on YouTube
                    </a>
                  </div>
                )}
                {!project.videoId && (
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
                <button className="drop" onClick={dropAtPlayhead} disabled={!ready || !project.videoId}>
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
                <button className="cover-btn" onClick={() => setCoverOpen(true)} disabled={!project.videoId}>
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

            {project.videoId && (
              <Timeline
                markers={markers}
                takes={takes}
                activeId={activeId}
                onSeek={(t) => seek(t)}
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
                    onRestamp={() => changeMarker(m.id, { time: Math.round(estimateNow() * 10) / 10 })}
                    onDelete={() => removeMarker(m)}
                    onRecord={() => startRecording(m)}
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
                    songTakeId={songTakeIds.get(m.id) ?? null}
                    looping={loop?.markerId === m.id}
                    onLoop={() => toggleLoop(m, i)}
                    showMeter={prefs.showMeter}
                  />
                ))
              )}
            </section>

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

function Readout() {
  const now = useClock((s) => Math.floor(s.now * 10));
  const dur = useClock((s) => Math.floor(s.duration));
  return (
    <div className="readout" aria-label="Playback time">
      <span className="now">{fmt(now / 10, true)}</span>
      <span className="dur">/ {fmt(dur)}</span>
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

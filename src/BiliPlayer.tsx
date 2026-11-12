import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines, ExternalLink, LoaderCircle, MessageSquare, Minus, Pause, Play, RefreshCw, Volume2, VolumeX, X } from "lucide-react";
import type { BiliDanmaku, BiliMode, BiliPlayback, BiliPlayRequest } from "./bilibili-types";
import "./bilibili.css";

const timeLabel = (seconds: number) => {
  const value = Math.floor(Math.max(0, Number.isFinite(seconds) ? seconds : 0));
  const short = `${Math.floor(value / 60) % 60}:${String(value % 60).padStart(2, "0")}`;
  return value >= 3600 ? `${Math.floor(value / 3600)}:${short.padStart(5, "0")}` : `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
};
const errorMessage = (cause: unknown, fallback: string) => {
  const message = cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "") : "";
  return message && message.length < 180 && !/https?:\/\/|SESSDATA|qrcode_key|cookie\s*[:=]/i.test(message) ? message : fallback;
};

function DanmakuLayer({ items, media, enabled, playing, time }: {
  items: BiliDanmaku[];
  media: { current: HTMLMediaElement | null };
  enabled: boolean;
  playing: boolean;
  time: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const context = element.getContext("2d");
    if (!context) return;
    let width = 0;
    let height = 0;
    let frame = 0;
    const render = () => {
      context.clearRect(0, 0, width, height);
      if (!enabled || !items.length) return;
      const current = media.current?.currentTime ?? time;
      const fontSize = Math.max(14, Math.min(23, height / 18));
      const rows = Math.max(2, Math.min(10, Math.floor((height - 76) / (fontSize * 1.65))));
      context.font = `600 ${fontSize}px "Microsoft YaHei", sans-serif`;
      context.textBaseline = "top";
      context.lineJoin = "round";
      context.lineWidth = 2;
      context.globalAlpha = 0.9;
      const occupied = new Set<string>();
      // Binary search keeps rendering independent of the video's total length.
      let low = 0, high = items.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (items[mid].time < current - 7) low = mid + 1;
        else high = mid;
      }
      let drawn = 0;
      for (let index = low; index < items.length && items[index].time <= current && drawn < 36; index++) {
        const item = items[index];
        const age = current - item.time;
        const fixed = item.mode === 4 || item.mode === 5;
        if (age > (fixed ? 4.5 : 7) || ![1, 2, 3, 4, 5, 6].includes(item.mode)) continue;
        const lane = index % rows;
        const key = `${fixed ? item.mode : 1}:${lane}`;
        if (occupied.has(key)) continue;
        occupied.add(key);
        const text = item.text.slice(0, 160);
        const textWidth = context.measureText(text).width;
        const x = fixed ? (width - textWidth) / 2
          : item.mode === 6 ? -textWidth + (width + textWidth) * age / 7
          : width - (width + textWidth) * age / 7;
        const y = item.mode === 4 ? height - 72 - (lane + 1) * fontSize * 1.65 : 45 + lane * fontSize * 1.65;
        context.strokeStyle = "#000000bd";
        context.fillStyle = `#${(Math.max(0, Math.min(0xffffff, item.color)) | 0).toString(16).padStart(6, "0")}`;
        context.strokeText(text, x, y);
        context.fillText(text, x, y);
        drawn++;
      }
    };
    const resize = () => {
      const bounds = element.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      const ratio = window.devicePixelRatio || 1;
      element.width = Math.round(width * ratio);
      element.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    const animate = () => { render(); frame = requestAnimationFrame(animate); };
    if (enabled && playing) frame = requestAnimationFrame(animate);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [items, enabled, playing, time, media]);
  return <canvas ref={canvas} className="bili-danmaku" aria-hidden="true" />;
}

export default function BiliPlayer() {
  const api = window.touchFish?.bilibili;
  const [playback, setPlayback] = useState<BiliPlayback | null>(null);
  const [playing, setPlaying] = useState(false);
  const [buffering, setBufferingValue] = useState(false);
  const [busy, setBusy] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.7);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [error, setErrorValue] = useState("");
  const [danmaku, setDanmaku] = useState(false);
  const [comments, setComments] = useState<BiliDanmaku[]>([]);
  const [danmakuMessage, setDanmakuMessage] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const clock = useRef<HTMLMediaElement | null>(null);
  const payload = useRef<BiliPlayback | null>(null);
  const mounted = useRef(false);
  const generation = useRef(0);
  const intent = useRef(false);
  const intentRevision = useRef(0);
  const positionReady = useRef(false);
  const starting = useRef(false);
  const desiredPosition = useRef(0);
  const changing = useRef(false);
  const operation = useRef(0);
  const playbackRevision = useRef(0);
  const scrub = useRef(false);
  const scrubValue = useRef(0);
  const pending = useRef<{ bvid: string; cid: number; mode: BiliMode; time: number; playing: boolean } | null>(null);
  const retry = useRef({ key: "", count: 0 });
  const commentCache = useRef(new Map<number, BiliDanmaku[]>());
  const bufferState = useRef(false);
  const failedState = useRef(false);
  const endedState = useRef(false);
  const latestTransportCommand = useRef(0);
  const setBuffering = useCallback((next: boolean) => {
    bufferState.current = next;
    setBufferingValue(next);
  }, []);
  const setError = useCallback((next: string) => {
    failedState.current = !!next;
    setErrorValue(next);
  }, []);

  const elements = useCallback((): HTMLMediaElement[] => {
    const current = payload.current;
    return [current?.mode === "video" && current.videoUrl ? video.current : null, current?.audioUrl ? audio.current : null]
      .filter((element): element is HTMLMediaElement => !!element);
  }, []);
  const publishTransport = useCallback((commandId?: number) => {
    const current = payload.current;
    const revision = current?.transportRevision;
    if (!api || !revision || !mounted.current) return;
    const tracks = elements();
    const ended = endedState.current || clock.current?.ended === true;
    const actualPlaying = tracks.length > 0 && tracks.every(track => !track.paused && !track.ended);
    api.reportTransportState({
      revision,
      ready: !changing.current && !pending.current && !failedState.current,
      playing: intent.current && !ended && actualPlaying,
      playIntent: intent.current && !ended && !failedState.current,
      buffering: intent.current && !ended && !failedState.current && (bufferState.current || !actualPlaying),
      ended,
      failed: failedState.current,
    }, commandId);
  }, [api, elements]);
  const pauseTracks = useCallback(() => {
    for (const element of elements()) element.pause();
    setPlaying(false);
    publishTransport();
  }, [elements, publishTransport]);
  const startTracks = useCallback(async (): Promise<void> => {
    const tracks = elements();
    if (!intent.current || !positionReady.current || starting.current || changing.current || pending.current || scrub.current ||
      !tracks.length || tracks.some(track => track.readyState < 2 || track.seeking)) return;
    const requestGeneration = generation.current;
    const requestIntent = intentRevision.current;
    starting.current = true;
    try {
      await Promise.all(tracks.map(track => track.play()));
      if (mounted.current && requestGeneration === generation.current && intent.current) {
        setPlaying(true);
        setBuffering(false);
        setError("");
      }
    } catch (cause) {
      if (mounted.current && requestGeneration === generation.current && requestIntent === intentRevision.current && intent.current &&
        !(cause instanceof DOMException && cause.name === "AbortError")) {
        pauseTracks();
        intent.current = false;
        setBuffering(false);
        setError("播放未能开始，请点击播放重试。");
      }
    } finally {
      if (requestGeneration === generation.current) starting.current = false;
      if (requestGeneration === generation.current) publishTransport();
      // A pause can abort an in-flight play(). If the latest explicit command
      // resumed again meanwhile, retry that intent after releasing the lock.
      if (mounted.current && requestGeneration === generation.current && requestIntent !== intentRevision.current &&
        intent.current && !failedState.current && tracks.some(track => track.paused)) void startTracks();
    }
  }, [elements, pauseTracks, publishTransport]);
  const prepare = useCallback(() => {
    const current = payload.current;
    const tracks = elements();
    if (!current || !tracks.length || tracks.some(track => track.readyState < 1)) return;
    const master = current.mode === "video" && current.videoUrl ? video.current : audio.current;
    if (!master) return;
    clock.current = master;
    const suppliedDuration = current.video.pages.find(page => page.cid === current.cid)?.duration || current.video.duration;
    const length = Number.isFinite(master.duration) && master.duration > 0 ? master.duration : suppliedDuration;
    setDuration(length);
    if (!positionReady.current) {
      const target = Math.max(0, Math.min(desiredPosition.current, Math.max(0, length - 0.05)));
      positionReady.current = true;
      for (const track of tracks) {
        if (Math.abs(track.currentTime - target) > 0.1) track.currentTime = target;
      }
      setTime(target);
    }
    if (intent.current) void startTracks();
    else setBuffering(false);
    publishTransport();
  }, [elements, startTracks, publishTransport]);

  useEffect(() => {
    mounted.current = true;
    if (!api) {
      setError("请从摸鱼时钟主面板打开播放器。");
      return () => { mounted.current = false; };
    }
    let active = true;
    let revision = 0;
    const off = api.onPlayback((next) => {
      revision++;
      playbackRevision.current++;
      if (active) {
        changing.current = false;
        setBusy(false);
        setPlayback(next);
      }
    });
    void api.getPlayback().then(next => {
      if (active && revision === 0) setPlayback(next);
    }).catch(cause => { if (active) setError(errorMessage(cause, "播放信息读取失败，请重新打开视频。")); });
    return () => {
      active = false;
      mounted.current = false;
      off();
      for (const element of [video.current, audio.current]) element?.pause();
    };
  }, [api]);

  useEffect(() => {
    generation.current++;
    latestTransportCommand.current = 0;
    endedState.current = false;
    starting.current = false;
    positionReady.current = false;
    payload.current = playback;
    const saved = pending.current;
    pending.current = null;
    const matching = !!playback && saved?.bvid === playback.video.bvid && saved.cid === playback.cid && saved.mode === playback.mode;
    desiredPosition.current = matching ? saved.time : 0;
    intent.current = !!playback && (matching ? saved.playing : true);
    setTime(desiredPosition.current);
    setDuration(playback?.video.pages.find(page => page.cid === playback.cid)?.duration || playback?.video.duration || 0);
    setPlaying(false);
    setBuffering(!!playback && intent.current);
    setError("");
    const key = playback ? `${playback.video.bvid}:${playback.cid}:${playback.mode}:${playback.quality}` : "";
    if (retry.current.key !== key) retry.current = { key, count: 0 };
    for (const element of [video.current, audio.current]) element?.pause();
    clock.current = playback?.mode === "video" && playback.videoUrl ? video.current : audio.current;
    prepare();
  }, [playback, prepare]);

  useEffect(() => { publishTransport(); }, [playback, playing, buffering, busy, error, publishTransport]);

  useEffect(() => {
    if (video.current) {
      video.current.muted = !!playback?.audioUrl || muted;
      video.current.volume = volume;
      video.current.playbackRate = rate;
    }
    if (audio.current) {
      audio.current.muted = muted;
      audio.current.volume = volume;
      audio.current.playbackRate = rate;
    }
  }, [playback, muted, volume, rate]);

  const changeSource = useCallback(async (request: BiliPlayRequest, start: number, shouldPlay = intent.current) => {
    if (!api || changing.current) return;
    const requestOperation = ++operation.current;
    const before = playbackRevision.current;
    changing.current = true;
    setBusy(true);
    setError("");
    const current = payload.current;
    pending.current = { bvid: request.bvid, cid: request.cid ?? current?.cid ?? 0, mode: request.mode, time: start, playing: shouldPlay };
    pauseTracks();
    try {
      await api.play(request);
    } catch (cause) {
      if (mounted.current && requestOperation === operation.current && before === playbackRevision.current) {
        pending.current = null;
        intent.current = false;
        pauseTracks();
        setBuffering(false);
        setError(errorMessage(cause, "暂时无法加载播放地址，请重试。"));
      }
    } finally {
      if (requestOperation === operation.current) {
        changing.current = false;
        if (mounted.current) { setBusy(false); prepare(); }
      }
    }
  }, [api, pauseTracks, prepare]);
  const reload = useCallback(() => {
    const current = payload.current;
    if (!current) return;
    retry.current.count = 0;
    void changeSource({ bvid: current.video.bvid, cid: current.cid, mode: current.mode, quality: current.quality }, clock.current?.currentTime || time, true);
  }, [changeSource, time]);
  const mediaError = useCallback((element: HTMLMediaElement) => {
    const current = payload.current;
    if (!current || changing.current) return;
    const expected = element === video.current ? current.videoUrl : current.audioUrl;
    if (!expected || element.currentSrc && element.currentSrc !== expected) return;
    const position = clock.current?.currentTime || desiredPosition.current;
    const wanted = intent.current;
    pauseTracks();
    setBuffering(false);
    if (retry.current.count < 1) {
      retry.current.count++;
      void changeSource({ bvid: current.video.bvid, cid: current.cid, mode: current.mode, quality: current.quality }, position, wanted);
    } else {
      intent.current = false;
      setError("当前视频或音轨暂时无法播放，请重试或切换清晰度。");
    }
  }, [changeSource, pauseTracks]);
  const seek = useCallback((target: number) => {
    const next = Math.max(0, Math.min(target, duration));
    if (next < duration - 0.1) endedState.current = false;
    desiredPosition.current = next;
    pauseTracks();
    setTime(next);
    if (!positionReady.current) return;
    setBuffering(intent.current);
    for (const track of elements()) {
      if (Number.isFinite(track.duration) || track.readyState >= 1) track.currentTime = next;
    }
    void startTracks();
    publishTransport();
  }, [duration, elements, pauseTracks, startTracks, publishTransport]);
  const requestPlaying = useCallback((shouldPlay: boolean) => {
    if (!payload.current) return;
    intentRevision.current++;
    intent.current = shouldPlay;
    if (pending.current) pending.current.playing = shouldPlay;
    if (!shouldPlay) {
      pauseTracks();
      setBuffering(false);
    } else {
      const master = clock.current;
      if (endedState.current || master?.ended || master && Number.isFinite(master.duration) && master.currentTime >= master.duration - 0.1) {
        endedState.current = false;
        seek(0);
      }
      setBuffering(true);
      void startTracks();
    }
    publishTransport();
  }, [pauseTracks, seek, startTracks, publishTransport]);
  const toggle = useCallback(() => requestPlaying(!intent.current), [requestPlaying]);

  useEffect(() => {
    if (!api) return;
    return api.onTransportCommand(command => {
      if (!mounted.current || command.revision !== payload.current?.transportRevision ||
        command.id < latestTransportCommand.current) return;
      if (command.id !== latestTransportCommand.current) {
        latestTransportCommand.current = command.id;
        requestPlaying(command.playing);
      }
      // Acknowledgement confirms the accepted intent. Loading/seeking may still
      // buffer; later reports describe the actual state of both media tracks.
      publishTransport(command.id);
    });
  }, [api, requestPlaying, publishTransport]);

  const trackActivity = useCallback(() => {
    const tracks = elements();
    setPlaying(tracks.length > 0 && tracks.every(track => !track.paused && !track.ended));
    publishTransport();
  }, [elements, publishTransport]);
  const tick = useCallback((element: HTMLMediaElement) => {
    if (element !== clock.current) return;
    if (!scrub.current) setTime(element.currentTime);
    if (Number.isFinite(element.duration) && element.duration > 0) setDuration(element.duration);
    const current = payload.current;
    if (current?.mode === "video" && current.audioUrl && video.current && audio.current &&
      !video.current.seeking && !audio.current.seeking && Math.abs(video.current.currentTime - audio.current.currentTime) > 0.3) {
      audio.current.currentTime = video.current.currentTime;
    }
  }, []);
  const waiting = useCallback(() => {
    if (!intent.current || !positionReady.current) return;
    setBuffering(true);
    pauseTracks();
  }, [pauseTracks]);
  const ended = useCallback((element: HTMLMediaElement) => {
    if (element !== clock.current) return;
    endedState.current = true;
    intent.current = false;
    pauseTracks();
    setBuffering(false);
    setTime(element.currentTime);
    publishTransport();
  }, [pauseTracks, publishTransport]);
  const modeSwitch = async () => {
    const current = payload.current;
    if (!api || !current || changing.current) return;
    const nextMode = current.mode === "audio" ? "video" : "audio";
    const requestOperation = ++operation.current;
    const before = playbackRevision.current;
    pending.current = { bvid: current.video.bvid, cid: current.cid, mode: nextMode, time: clock.current?.currentTime || time, playing: intent.current };
    changing.current = true;
    setBusy(true);
    setError("");
    pauseTracks();
    try { await api.setPlayerMode(nextMode); }
    catch (cause) {
      if (mounted.current && requestOperation === operation.current && before === playbackRevision.current) {
        pending.current = null;
        intent.current = false;
        setBuffering(false);
        setError(errorMessage(cause, "播放模式切换失败，请重试。"));
      }
    } finally {
      if (requestOperation === operation.current) {
        changing.current = false;
        if (mounted.current) { setBusy(false); prepare(); }
      }
    }
  };

  useEffect(() => {
    if (!playback || !danmaku || playback.mode !== "video") { setComments([]); setDanmakuMessage(""); return; }
    let active = true;
    const cached = commentCache.current.get(playback.cid);
    if (cached) { setComments(cached); return; }
    setDanmakuMessage("正在加载弹幕…");
    void api?.getDanmaku(playback.cid).then(next => {
      const sorted = next.filter(item => Number.isFinite(item.time) && item.time >= 0 && typeof item.text === "string")
        .slice(0, 10_000).sort((a, b) => a.time - b.time);
      commentCache.current.set(playback.cid, sorted);
      if (active) { setComments(sorted); setDanmakuMessage(sorted.length ? "" : "这个分 P 暂无弹幕"); }
    }).catch(() => { if (active) { setComments([]); setDanmakuMessage("弹幕加载失败，可关闭后重新开启"); } });
    return () => { active = false; };
  }, [api, playback?.cid, playback?.mode, danmaku]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const control = target?.closest("input,select,button,[contenteditable='true']");
      if (control || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.code === "Space") { event.preventDefault(); toggle(); }
      if (event.code === "ArrowLeft") { event.preventDefault(); seek((clock.current?.currentTime || 0) - 5); }
      if (event.code === "ArrowRight") { event.preventDefault(); seek((clock.current?.currentTime || 0) + 5); }
      if (event.code === "Escape") { event.preventDefault(); api?.closePlayer(); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [api, toggle, seek]);
  useEffect(() => {
    if (!playback || !("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: playback.video.title, artist: playback.video.owner, album: "B 站 · 摸鱼时钟" });
    const callbacks: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", () => requestPlaying(true)],
      ["pause", () => requestPlaying(false)],
      ["seekbackward", event => seek((clock.current?.currentTime || 0) - (event.seekOffset || 5))],
      ["seekforward", event => seek((clock.current?.currentTime || 0) + (event.seekOffset || 5))],
      ["seekto", event => { if (event.seekTime !== undefined) seek(event.seekTime); }],
    ];
    for (const [action, callback] of callbacks) { try { navigator.mediaSession.setActionHandler(action, callback); } catch {} }
    return () => { for (const [action] of callbacks) { try { navigator.mediaSession.setActionHandler(action, null); } catch {} } };
  }, [playback, requestPlaying, seek]);
  useEffect(() => {
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }, [playing]);

  const audioMode = playback?.mode === "audio";
  const qualities = playback?.qualities ?? [];
  return (
    <div className={`bili-player ${audioMode ? "audio-mode" : "video-mode"} ${error ? "has-error" : ""}`} tabIndex={0} aria-label="B站播放器" onContextMenu={event => event.preventDefault()}>
      <video ref={video} className="bili-video" src={!audioMode ? playback?.videoUrl ?? undefined : undefined} playsInline preload="auto" disablePictureInPicture
        onLoadedMetadata={prepare} onCanPlay={prepare} onSeeked={prepare} onWaiting={waiting}
        onPlaying={trackActivity} onPause={trackActivity}
        onTimeUpdate={event => tick(event.currentTarget)} onEnded={event => ended(event.currentTarget)} onError={event => mediaError(event.currentTarget)} />
      <audio ref={audio} src={playback?.audioUrl ?? undefined} preload="auto"
        onLoadedMetadata={prepare} onCanPlay={prepare} onSeeked={prepare} onWaiting={waiting}
        onPlaying={trackActivity} onPause={trackActivity}
        onTimeUpdate={event => tick(event.currentTarget)} onEnded={event => ended(event.currentTarget)} onError={event => mediaError(event.currentTarget)} />
      {audioMode && <div className="bili-audio-stage">
        {playback?.video.cover && <img className="bili-audio-backdrop" src={playback.video.cover} alt="" />}
        <div className={`bili-audio-symbol ${playing ? "playing" : ""}`}><AudioLines size={31} /></div>
        <strong>{playback?.video.title}</strong><small>{playback?.video.owner}</small>
      </div>}
      <DanmakuLayer items={comments} media={clock} enabled={danmaku && !audioMode && !error} playing={playing} time={time} />
      {!playback && !error && <div className="bili-player-loading"><LoaderCircle size={25} className="bili-spinning" /><span>正在打开视频…</span></div>}
      {(buffering || busy) && !error && <div className="bili-buffering" role="status"><LoaderCircle size={25} className="bili-spinning" /><span>{busy ? "正在切换…" : "正在缓冲…"}</span></div>}
      {error && <div className="bili-player-error" role="alert"><strong>暂时无法播放</strong><p>{error}</p><div><button onClick={reload} disabled={busy || !playback}><RefreshCw size={14} />重试播放</button><button onClick={() => void api?.openVideoPage().catch(() => {})} disabled={!playback}><ExternalLink size={14} />原站查看</button></div></div>}
      <div className="bili-chrome bili-player-top">
        <div className="bili-player-title" title={playback?.video.title}>{playback?.video.title || "B 站播放器"}<small>{playback ? `${playback.video.bvid} · ${audioMode ? "只听音频" : "视频小窗"}` : "摸鱼时钟"}</small></div>
        <div className="bili-window-actions">
          <button title={audioMode ? "切换到视频" : "只听音频"} aria-label={audioMode ? "切换到视频" : "只听音频"} onClick={() => void modeSwitch()} disabled={busy || !playback}><AudioLines size={16} /></button>
          <button title="在B站查看" aria-label="在B站查看" onClick={() => void api?.openVideoPage().catch(() => {})} disabled={!playback}><ExternalLink size={15} /></button>
          <button title="最小化" aria-label="最小化播放器" onClick={() => api?.minimizePlayer()}><Minus size={17} /></button>
          <button title="关闭并停止播放" aria-label="关闭播放器" onClick={() => api?.closePlayer()}><X size={18} /></button>
        </div>
      </div>
      <div className="bili-chrome bili-player-bottom">
        {danmakuMessage && <span className="bili-danmaku-message" role="status">{danmakuMessage}</span>}
        <div className="bili-progress-row"><span>{timeLabel(time)}</span><input aria-label="播放进度" type="range" min="0" max={Math.max(0.1, duration)} step="0.1" value={Math.min(time, duration || time)} disabled={!playback || busy} onPointerDown={event => { scrub.current = true; scrubValue.current = time; event.currentTarget.setPointerCapture(event.pointerId); pauseTracks(); }} onChange={event => {
          const value = Number(event.target.value); scrubValue.current = value; setTime(value); if (!scrub.current) seek(value);
        }} onPointerUp={() => { if (scrub.current) { scrub.current = false; seek(scrubValue.current); } }} onPointerCancel={() => { scrub.current = false; seek(scrubValue.current); }} /><span>{timeLabel(duration)}</span></div>
        <div className="bili-controls-row">
          <button className="bili-toggle" aria-label={playing || buffering ? "暂停播放" : "播放"} title={playing || buffering ? "暂停（空格）" : "播放（空格）"} onClick={toggle} disabled={!playback || busy}>{playing || buffering ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button>
          <button aria-label={muted ? "取消静音" : "静音"} title={muted ? "取消静音" : "静音"} onClick={() => setMuted(!muted)}>{muted || volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>
          <input className="bili-volume" aria-label="音量" type="range" min="0" max="1" step="0.05" value={volume} onChange={event => { setVolume(Number(event.target.value)); setMuted(false); }} />
          <div className="bili-controls-spacer" />
          <select aria-label="播放速度" title="播放速度" value={rate} onChange={event => setRate(Number(event.target.value))}>{[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].map(value => <option key={value} value={value}>{value}×</option>)}</select>
          {!audioMode && <select className="bili-quality" aria-label="清晰度" title="清晰度" value={playback?.quality ?? 0} disabled={busy || !qualities.length} onChange={event => {
            if (playback) void changeSource({ bvid: playback.video.bvid, cid: playback.cid, mode: playback.mode, quality: Number(event.target.value) }, clock.current?.currentTime || time);
          }}>{!qualities.some(item => item.id === playback?.quality) && <option value={playback?.quality ?? 0}>默认画质</option>}{qualities.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select>}
          {playback && playback.video.pages.length > 1 && <select className="bili-player-pages" aria-label="切换分P" title="切换分P" value={playback.cid} disabled={busy} onChange={event => {
            void changeSource({ bvid: playback.video.bvid, cid: Number(event.target.value), mode: playback.mode, quality: playback.quality }, 0, true);
          }}>{playback.video.pages.map(page => <option key={page.cid} value={page.cid}>P{page.page} · {page.title}</option>)}</select>}
          {!audioMode && <button className={danmaku ? "selected" : ""} aria-label={danmaku ? "关闭弹幕" : "打开弹幕"} aria-pressed={danmaku} title={danmaku ? "关闭弹幕" : "打开弹幕"} onClick={() => setDanmaku(!danmaku)}><MessageSquare size={17} /></button>}
        </div>
      </div>
    </div>
  );
}

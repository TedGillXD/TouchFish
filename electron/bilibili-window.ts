import { BrowserWindow, screen } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import type { BiliPlayback, BiliPlayerState, BiliTransportState } from "../src/bilibili-types";
import { createBilibiliTransport } from "./bilibili-transport";

interface PlayerWindowOptions {
  root: string;
  preload: string;
  devServer?: string;
  onState: (state: BiliPlayerState) => void;
  onTransportState: (state: BiliTransportState) => void;
}

/** A normal desktop window: other applications and dialogs can cover it. */
export function createBilibiliWindow(options: PlayerWindowOptions) {
  let window: BrowserWindow | null = null;
  let loading: Promise<void> | null = null;
  let current: BiliPlayback | null = null;
  let disposed = false;
  let privacyPaused = false;
  let restoreRequested = false;
  let privacyEpoch = 0;
  let concealment: { visible: boolean; minimized: boolean; muted: boolean } | null = null;
  let pausePending: Promise<void> | null = null;
  const transport = createBilibiliTransport({
    onState: state => {
      options.onTransportState(publicTransport(state));
      if (!privacyPaused || !state.open || !state.ready) return;
      if (state.playIntent || state.playing) void pauseForPrivacy().catch(() => {});
      else if (restoreRequested) releasePrivacyPause();
    },
    send: command => {
      if (!window || window.isDestroyed() || window.webContents.isDestroyed())
        throw new Error("播放器已关闭。");
      window.webContents.send("bilibili:transport-command", command);
    },
  });
  const getState = (): BiliPlayerState => ({
    open: !!window && !window.isDestroyed(),
    mode: current?.mode ?? "video",
    bvid: current?.video.bvid ?? null,
    title: current?.video.title ?? "",
  });
  const publish = () => options.onState(getState());

  function publicTransport(state: BiliTransportState): BiliTransportState {
    return privacyPaused ? { ...state, playing: false, playIntent: false, buffering: false } : state;
  }

  function releasePrivacyPause() {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.setAudioMuted(concealment?.muted ?? false);
    privacyPaused = false;
    restoreRequested = false;
    concealment = null;
  }

  function pauseForPrivacy(): Promise<void> {
    if (pausePending) return pausePending;
    const state = transport.getState();
    if (!state.open || !state.ready || (!state.playIntent && !state.playing)) return Promise.resolve();
    const operation = transport.setPlaying(false, state.revision).then(() => {});
    const settled = operation.finally(() => { if (pausePending === settled) pausePending = null; });
    pausePending = settled;
    return settled;
  }

  async function pauseAndHide(): Promise<void> {
    privacyEpoch++;
    privacyPaused = true;
    restoreRequested = false;
    if (window && !window.isDestroyed()) {
      if (!concealment) concealment = { visible: window.isVisible(), minimized: window.isMinimized(), muted: window.webContents.isAudioMuted() };
      window.webContents.setAudioMuted(true);
      window.minimize();
      window.hide();
    }
    options.onTransportState(publicTransport(transport.getState()));
    await pauseForPrivacy();
  }

  async function restorePaused(): Promise<void> {
    const epoch = ++privacyEpoch;
    const previous = concealment;
    restoreRequested = true;
    await pauseForPrivacy().catch(() => {});
    if (epoch !== privacyEpoch) return;
    const state = transport.getState();
    if (!state.open || (state.ready && !state.playIntent && !state.playing)) releasePrivacyPause();
    if (window && !window.isDestroyed() && previous?.visible) {
      window.showInactive();
      if (previous.minimized) window.minimize();
      else window.restore();
    }
  }

  async function open(playback: BiliPlayback, activate = true): Promise<void> {
    if (disposed) throw new Error("播放器已关闭。");
    if (privacyPaused) throw new Error("摸鱼窗口已收起，请先从托盘恢复窗口。");
    if (loading) await loading;
    if (disposed) throw new Error("播放器已关闭。");
    if (privacyPaused) throw new Error("摸鱼窗口已收起，请先从托盘恢复窗口。");
    current = { ...playback, transportRevision: transport.beginSource() };
    if (window && !window.isDestroyed()) {
      window.setTitle(`${playback.video.title.slice(0, 100)} · 摸鱼播放器`);
      window.webContents.send("bilibili:playback", current);
      if (activate) { window.show(); window.focus(); }
      publish();
      return;
    }
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(playback.mode === "audio" ? 440 : 720, area.width);
    const height = Math.min(playback.mode === "audio" ? 230 : 405, area.height);
    let player: BrowserWindow;
    try { player = new BrowserWindow({
      width, height,
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      minWidth: 320,
      minHeight: 180,
      show: false,
      frame: false,
      resizable: true,
      maximizable: true,
      minimizable: true,
      fullscreenable: true,
      skipTaskbar: false,
      alwaysOnTop: false,
      backgroundColor: "#101614",
      hasShadow: true,
      roundedCorners: true,
      title: `${playback.video.title.slice(0, 100)} · 摸鱼播放器`,
      icon: join(options.root, "assets", "icon.png"),
      webPreferences: {
        preload: options.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
        autoplayPolicy: "no-user-gesture-required",
      },
    }); } catch (error) { current = null; transport.close(); publish(); throw error; }
    window = player;
    publish();
    player.setMenu(null);
    player.on("page-title-updated", event => event.preventDefault());
    player.on("system-context-menu", event => event.preventDefault());
    player.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    player.webContents.on("will-navigate", event => event.preventDefault());
    player.webContents.on("will-attach-webview", event => event.preventDefault());
    player.on("closed", () => {
      if (window === player) { privacyEpoch++; window = null; current = null; transport.close(); concealment = null; }
      publish();
    });
    loading = (async () => {
      if (options.devServer) {
        const url = new URL(options.devServer);
        if (!["http:", "https:"].includes(url.protocol) ||
          !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
          throw new Error("开发服务器必须使用本机地址。");
        url.searchParams.set("window", "player");
        await player.loadURL(url.toString());
      } else {
        await player.loadFile(join(options.root, "dist", "index.html"), { query: { window: "player" } });
      }
      if (!player.isDestroyed() && !disposed && !privacyPaused) {
        player.show();
        player.focus();
        publish();
      }
    })();
    try { await loading; }
    catch (error) { if (!player.isDestroyed()) player.destroy(); throw error; }
    finally { loading = null; }
  }

  return {
    open,
    getState,
    getPlayback: () => current,
    getTransportState: () => publicTransport(transport.getState()),
    setPlaying: (playing: unknown, revision: unknown) => privacyPaused && playing === true
      ? Promise.reject(new Error("摸鱼窗口已收起，请先从托盘恢复窗口。"))
      : transport.setPlaying(playing, revision),
    reportTransportState: transport.report,
    getWindow: () => window,
    isSender: (event: IpcMainEvent | IpcMainInvokeEvent): boolean => !!window && !window.isDestroyed() &&
      event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame,
    show: () => { if (!privacyPaused && window && !window.isDestroyed()) { window.show(); window.focus(); } },
    minimize: () => window?.minimize(),
    close: () => window?.close(),
    pauseAndHide,
    restorePaused,
    dispose: () => { disposed = true; transport.close(); window?.destroy(); window = null; current = null; },
  };
}

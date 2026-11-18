import { BrowserWindow, ipcMain, screen, session, WebContentsView } from "electron";
import type { Event, IpcMainEvent, Session, WebContents } from "electron";
import { join } from "node:path";
import type { HongguoState } from "../src/hongguo-types";
import { HONGGUO_HOME, HONGGUO_PARTITION, isHongguoNavigation, isHongguoWebsite, normalizeHongguoUrl } from "./hongguo-policy";

type MediaGate = "open" | "concealed" | "paused";

interface Options {
  root: string;
  preload: string;
  chromePreload: string;
  devServer?: string;
  onState: (state: HongguoState) => void;
}

interface HongguoWindow {
  host: BrowserWindow;
  view: WebContentsView;
}

const loadError = "红果网页暂时打不开，请检查网络后重试。";
const toolbarHeight = 36;

/** A dedicated browser window owns the official page and its local login session. */
export function createHongguoWindow(options: Options) {
  let window: HongguoWindow | null = null;
  let network: Session | null = null;
  let disposed = false;
  let loading = false;
  let error: string | null = null;
  let retryUrl = HONGGUO_HOME;
  let navigation = 0;
  let visibility = 0;
  let concealed = false;
  let beforeHide: { visible: boolean; muted: boolean } | null = null;
  let gate: MediaGate = "open";
  let hasPreload = false;
  let gateSequence = 0;
  let waiting: { id: number; done: (error?: Error) => void; promise: Promise<void> } | null = null;

  function activeWindow() {
    return window && !window.host.isDestroyed() && !window.view.webContents.isDestroyed() ? window : null;
  }

  function getState(): HongguoState {
    const current = activeWindow()?.host;
    return {
      open: !!current,
      visible: !!current && !concealed && current.isVisible() && !current.isMinimized(),
      concealed,
      loading,
      error,
    };
  }

  function publish() {
    if (!disposed) options.onState(getState());
  }

  function isSender(event: IpcMainEvent, contents?: WebContents) {
    return !!contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame;
  }

  function initialGate(event: IpcMainEvent) {
    if (!isSender(event, activeWindow()?.view.webContents)) {
      event.returnValue = "concealed";
      return;
    }
    hasPreload = true;
    event.returnValue = gate;
    waiting?.done();
  }

  function acknowledgeGate(event: IpcMainEvent, id: unknown) {
    if (isSender(event, activeWindow()?.view.webContents) && waiting && waiting.id === id) waiting.done();
  }

  function releaseGate(event: IpcMainEvent) {
    if (isSender(event, activeWindow()?.view.webContents) && getState().visible && gate === "paused") gate = "open";
  }

  function windowAction(event: IpcMainEvent, action: unknown) {
    const current = activeWindow();
    if (!current || !isSender(event, current.host.webContents)) return;
    const { host, view: { webContents: contents } } = current;
    if (action === "close") host.close();
    else if (concealed) return;
    else if (action === "minimize") host.minimize();
    else if (action === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (action === "home") void loadPage(current, HONGGUO_HOME);
    else if (action === "reload") {
      if (!error && isHongguoNavigation(contents.getURL())) contents.reload();
      else void loadPage(current, retryUrl);
    }
  }

  ipcMain.on("hongguo:privacy-state", initialGate);
  ipcMain.on("hongguo:privacy-ack", acknowledgeGate);
  ipcMain.on("hongguo:media-interaction", releaseGate);
  ipcMain.on("hongguo:window-action", windowAction);

  function sendGate(mode: MediaGate): Promise<void> {
    gate = mode;
    waiting?.done();
    const contents = activeWindow()?.view.webContents;
    if (!contents || !hasPreload) return Promise.resolve();

    const id = ++gateSequence;
    let done!: (failure?: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => done(new Error("红果小窗未确认暂停。")), 1500);
      done = failure => {
        clearTimeout(timer);
        if (waiting?.id === id) waiting = null;
        if (failure) reject(failure);
        else resolve();
      };
    });
    waiting = { id, done, promise };
    try { contents.send("hongguo:privacy", mode, id); }
    catch { done(new Error("红果小窗未确认暂停。")); }
    return promise;
  }

  const denyDownload = (event: Event) => event.preventDefault();
  function canUseFullscreen(contents: WebContents | null, permission: string, mainFrame: boolean, url?: string) {
    const current = activeWindow();
    return permission === "fullscreen" && !concealed && mainFrame && !!current &&
      current.host.isVisible() && !current.host.isMinimized() &&
      contents === current.view.webContents && !!url && isHongguoWebsite(url);
  }

  function getSession(): Session {
    if (!network) {
      network = session.fromPartition(HONGGUO_PARTITION);
      network.setPermissionRequestHandler((contents, permission, callback, details) =>
        callback(canUseFullscreen(contents, permission, details.isMainFrame, details.requestingUrl)));
      network.setPermissionCheckHandler((contents, permission, origin, details) =>
        canUseFullscreen(contents, permission, details.isMainFrame, details.requestingUrl ?? origin));
      network.setDisplayMediaRequestHandler((_request, callback) => callback({}));
      network.on("will-download", denyDownload);
    }
    return network;
  }

  async function flush(): Promise<void> {
    network?.flushStorageData();
    await network?.cookies.flushStore();
  }

  async function pauseAndHide(): Promise<void> {
    visibility++;
    const current = activeWindow();
    const alreadyConcealed = concealed;
    if (!alreadyConcealed && current) {
      beforeHide = {
        visible: current.host.isVisible() && !current.host.isMinimized(),
        muted: current.view.webContents.isAudioMuted(),
      };
    }
    concealed = true;
    if (current) {
      current.view.webContents.setAudioMuted(true);
      current.host.hide();
    }
    publish();
    if (alreadyConcealed && gate === "concealed" && waiting) return waiting.promise;
    await sendGate("concealed");
  }

  async function restorePaused(): Promise<void> {
    if (!concealed) return;
    const request = ++visibility;
    const current = window;
    await sendGate("paused");
    if (request !== visibility || disposed) return;
    const previous = beforeHide;
    beforeHide = null;
    concealed = false;
    if (current && current === activeWindow()) {
      current.view.webContents.setAudioMuted(previous?.muted ?? false);
      if (previous?.visible) current.host.showInactive();
    }
    publish();
  }

  async function loadChrome(host: BrowserWindow): Promise<void> {
    if (!options.devServer) {
      return host.loadFile(join(options.root, "dist", "index.html"), { query: { window: "hongguo-chrome" } });
    }
    const url = new URL(options.devServer);
    if (!["http:", "https:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      throw new Error("开发服务器必须使用本机地址。");
    }
    url.searchParams.set("window", "hongguo-chrome");
    return host.loadURL(url.href);
  }

  function newWindow(): HongguoWindow {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(area.width, 820);
    const height = Math.min(area.height, 630);
    const host = new BrowserWindow({
      width, height,
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      minWidth: Math.min(width, 420),
      minHeight: Math.min(height, 320),
      title: "红果短剧 · 摸鱼时钟",
      backgroundColor: "#171717",
      show: false,
      frame: false,
      roundedCorners: true,
      icon: join(options.root, "assets", "icon.png"),
      webPreferences: {
        preload: options.chromePreload,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
      },
    });
    let view: WebContentsView;
    try {
      view = new WebContentsView({
        webPreferences: {
          session: getSession(),
          preload: options.preload,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          webviewTag: false,
          backgroundThrottling: false,
          disableHtmlFullscreenWindowResize: true,
        },
      });
    } catch (cause) {
      host.destroy();
      throw cause;
    }
    const current = { host, view };
    window = current;
    hasPreload = false;
    gate = "open";
    host.setMenu(null);
    host.on("page-title-updated", event => event.preventDefault());
    host.on("hide", publish);
    host.on("minimize", publish);
    host.on("restore", publish);
    // A late native show must not surface a window while the boss key is active.
    host.on("show", () => {
      if (concealed) host.hide();
      else publish();
    });
    const contents = view.webContents;
    host.on("closed", () => {
      if (window === current) {
        window = null;
        navigation++;
        loading = false;
        beforeHide = null;
        hasPreload = false;
        waiting?.done();
        publish();
      }
      // BrowserWindow does not own the WebContentsView's renderer lifetime.
      if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
      void flush().catch(() => {});
    });

    host.contentView.addChildView(view);
    view.setBackgroundColor("#171717");
    const layout = () => {
      if (host.isDestroyed()) return;
      const bounds = host.getContentBounds();
      view.setBounds({ x: 0, y: toolbarHeight, width: bounds.width, height: Math.max(0, bounds.height - toolbarHeight) });
    };
    host.on("resize", layout);
    layout();

    const failWindow = (message: string) => {
      if (host.isDestroyed() || window !== current) return;
      error = message;
      host.destroy();
    };
    const chrome = host.webContents;
    chrome.setWindowOpenHandler(() => ({ action: "deny" }));
    chrome.on("will-navigate", event => event.preventDefault());
    chrome.on("will-redirect", event => event.preventDefault());
    chrome.on("will-attach-webview", event => event.preventDefault());
    chrome.on("preload-error", () => failWindow("红果小窗工具栏加载失败，请重新打开。"));
    chrome.on("render-process-gone", () => failWindow("红果小窗工具栏已停止运行，请重新打开。"));
    void loadChrome(host).catch(() => failWindow("红果小窗工具栏加载失败，请重新打开。"));

    contents.setWindowOpenHandler(({ url, postBody }) => {
      if (!concealed && !postBody && isHongguoNavigation(url)) {
        // Some official episode links open a tab. Keep them in the owned window.
        setImmediate(() => {
          if (!disposed && !concealed && activeWindow() === current) void loadPage(current, url);
        });
      }
      return { action: "deny" };
    });
    contents.on("will-attach-webview", event => event.preventDefault());
    contents.on("will-navigate", event => {
      if (concealed || !isHongguoNavigation(event.url)) event.preventDefault();
    });
    contents.on("will-redirect", event => {
      if (event.isMainFrame && !isHongguoNavigation(event.url)) event.preventDefault();
    });
    contents.on("will-prevent-unload", event => event.preventDefault());
    contents.on("before-input-event", (event, input) => {
      if (concealed || input.type !== "keyDown" || !input.alt || (input.key !== "ArrowLeft" && input.key !== "ArrowRight")) return;
      event.preventDefault();
      const history = contents.navigationHistory;
      if (input.key === "ArrowLeft" && history.canGoBack()) history.goBack();
      if (input.key === "ArrowRight" && history.canGoForward()) history.goForward();
    });
    contents.on("did-start-navigation", details => {
      if (window !== current || !details.isMainFrame || details.isSameDocument || !isHongguoNavigation(details.url)) return;
      retryUrl = details.url;
      loading = true;
      error = null;
      publish();
    });
    contents.on("did-stop-loading", () => {
      if (window !== current) return;
      loading = false;
      publish();
    });
    contents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
      if (window !== current || !isMainFrame || code === -3) return; // Chromium aborts a superseded load.
      error = loadError;
      publish();
    });
    contents.on("preload-error", () => failWindow("红果页面未能初始化，请重新打开小窗。"));
    contents.on("render-process-gone", () => failWindow("红果页面已停止运行，请重新打开小窗。"));
    contents.on("destroyed", () => failWindow("红果页面已关闭，请重新打开小窗。"));
    return current;
  }

  async function loadPage(current: HongguoWindow, target: string): Promise<void> {
    if (!isHongguoNavigation(target) || current !== activeWindow()) return;
    const request = ++navigation;
    try { await current.view.webContents.loadURL(target); }
    catch {
      if (request === navigation && window === current && !error) {
        error = loadError;
        publish();
      }
    }
  }

  async function open(input?: unknown): Promise<HongguoState> {
    if (disposed) throw new Error("红果小窗服务已关闭。");
    if (concealed) throw new Error("红果小窗已收起，请先恢复摸鱼窗口。");
    const requested = normalizeHongguoUrl(input);
    const existing = activeWindow();
    const current = existing ?? newWindow();
    const { host, view: { webContents: contents } } = current;
    if (host.isMinimized()) host.restore();
    host.show();
    host.focus();
    contents.focus();
    if (!existing || error || (requested && requested !== contents.getURL())) {
      await loadPage(current, requested ?? (existing ? retryUrl : HONGGUO_HOME));
    }
    return getState();
  }

  return {
    getState, open, pauseAndHide, restorePaused, flush,
    close() { activeWindow()?.host.close(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      visibility++;
      waiting?.done();
      ipcMain.removeListener("hongguo:privacy-state", initialGate);
      ipcMain.removeListener("hongguo:privacy-ack", acknowledgeGate);
      ipcMain.removeListener("hongguo:media-interaction", releaseGate);
      ipcMain.removeListener("hongguo:window-action", windowAction);
      network?.removeListener("will-download", denyDownload);
      if (window && !window.host.isDestroyed()) window.host.destroy();
    },
  };
}

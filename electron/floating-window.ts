import { app, BrowserWindow, dialog, ipcMain, Menu, screen } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent, Rectangle } from "electron";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FloatingState } from "../src/floating-types";
import { floatingBounds, validFloatingPosition, type FloatingPosition } from "./floating-layout";

type SenderEvent = IpcMainEvent | IpcMainInvokeEvent;
interface Preferences {
  version: 1;
  enabled: boolean;
  expanded: boolean;
  privacy: boolean;
  position?: FloatingPosition;
}

interface FloatingOptions {
  root: string;
  preload: string;
  devServer?: string;
  showPanel: () => void;
  isMainSender: (event: SenderEvent) => boolean;
  onState?: (state: FloatingState) => void;
}

/** A read-only companion window. Payroll state and updater authority stay in main.ts. */
export async function createFloatingController(options: FloatingOptions) {
  const supported = process.platform === "win32";
  const directory = app.getPath("userData");
  const path = join(directory, "floating.json");
  const temporary = join(directory, "floating.tmp.json");
  let preferences: Preferences = {
    version: 1,
    enabled: supported,
    expanded: false,
    privacy: false,
  };
  try {
    const text = await readFile(path, "utf8");
    if (text.length > 16_384) throw new Error("悬浮窗设置文件过大。");
    const raw = JSON.parse(text);
    if (!raw || raw.version !== 1 || Array.isArray(raw) ||
      typeof raw.enabled !== "boolean" || typeof raw.expanded !== "boolean" ||
      typeof raw.privacy !== "boolean")
      throw new Error("悬浮窗设置格式不正确。");
    if (raw.position !== undefined && !validFloatingPosition(raw.position))
      await copyFile(path, join(directory, "floating.invalid.json")).catch(() => {});
    preferences = {
      version: 1,
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : supported,
      expanded: raw.expanded === true,
      privacy: raw.privacy === true,
      ...(validFloatingPosition(raw.position)
        ? { position: { x: Math.round(raw.position.x), y: Math.round(raw.position.y) } }
        : {}),
    };
  } catch (error) {
    // An unreadable preference file must not unexpectedly reveal an amount.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      await copyFile(path, join(directory, "floating.invalid.json")).catch(() => {});
      preferences = { ...preferences, enabled: false, privacy: true };
    }
  }

  let window: BrowserWindow | null = null;
  let initializing: Promise<void> | null = null;
  let writeQueue: Promise<void> = Promise.resolve();
  let lastWriteError: Error | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let expectedBounds: Rectangle | undefined;
  let applyingBounds = false;
  let movePending = false;
  let quitting = false;
  let disposed = false;

  const getState = (): FloatingState => ({
    supported,
    enabled: supported && preferences.enabled,
    expanded: preferences.expanded,
    privacy: preferences.privacy,
  });

  const isSender = (event: SenderEvent): boolean =>
    !!window && !window.isDestroyed() &&
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame;

  const assertSender = (event: SenderEvent): void => {
    if (!options.isMainSender(event) && !isSender(event))
      throw new Error("无法识别的悬浮窗请求。");
  };

  function persist(): Promise<void> {
    const text = JSON.stringify(preferences, null, 2);
    const operation = writeQueue.then(async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flush: true });
      await rename(temporary, path);
      lastWriteError = null;
    });
    writeQueue = operation.catch((error: Error) => { lastWriteError = error; });
    return operation.catch((error: Error) => {
      throw new Error(`悬浮窗设置保存失败：${error.message}`);
    });
  }

  function schedulePersist(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      settleMove();
      void persist().catch(() => {});
    }, 250);
  }

  function publish(): void {
    const state = getState();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.send("floating:state", state);
    options.onState?.(state);
  }

  function bounds(expanded = preferences.expanded): Rectangle {
    const displays = screen.getAllDisplays();
    return floatingBounds(
      preferences.position,
      expanded,
      displays.map((display) => display.workArea),
      displays.findIndex((display) => display.id === screen.getPrimaryDisplay().id),
    );
  }

  function applyBounds(): void {
    if (!window || window.isDestroyed() || applyingBounds) return;
    // A deliberate resize/recovery keeps the remembered compact anchor. A
    // previously scheduled move callback must not adopt its clamped position.
    movePending = false;
    const target = bounds();
    const current = window.getBounds();
    expectedBounds = current;
    if (["x", "y", "width", "height"].every(
      (key) => current[key as keyof Rectangle] === target[key as keyof Rectangle],
    )) return;
    // Windows may emit move/moved synchronously from setBounds and round the
    // requested DIP coordinates. Do not treat those events as another drag.
    applyingBounds = true;
    try {
      window.setBounds(target, false);
      if (!window.isDestroyed()) expectedBounds = window.getBounds();
    } finally {
      applyingBounds = false;
    }
  }

  function settleMove(): void {
    if (!movePending || !window || window.isDestroyed() || quitting || disposed) return;
    movePending = false;
    const current = window.getBounds();
    preferences.position = { x: current.x, y: current.y };
    const clamped = bounds();
    preferences.position = { x: clamped.x, y: clamped.y };
    // Reset the complete bounds: a move far outside a monitor may also make
    // Windows round the size through a different monitor's DPI scale.
    applyBounds();
  }

  function rememberMove(final = false): void {
    if (!window || window.isDestroyed() || applyingBounds || quitting || disposed) return;
    const current = window.getBounds();
    if (expectedBounds && ["x", "y"].every(
      (key) => current[key as keyof Rectangle] === expectedBounds![key as keyof Rectangle],
    )) return;
    // Programmatic resize events match expectedBounds. Only a real move changes
    // the compact anchor, so expanding near an edge does not make it creep.
    preferences.position = { x: current.x, y: current.y };
    expectedBounds = undefined;
    movePending = true;
    if (final) settleMove();
    // Windows can emit only `move` for setPosition, without a later `moved`.
    // The quiet-period callback therefore performs the same final clamp.
    schedulePersist();
  }

  function recoverPosition(): void {
    if (!window || window.isDestroyed()) return;
    const compact = bounds(false);
    preferences.position = { x: compact.x, y: compact.y };
    applyBounds();
    schedulePersist();
  }

  function nativeOperation(operation: Promise<unknown>): void {
    void operation.catch((error: Error) => {
      dialog.showErrorBox("悬浮窗设置保存失败", error.message);
    });
  }

  function menu(): void {
    if (!window || window.isDestroyed()) return;
    Menu.buildFromTemplate([
      { label: "打开完整面板", click: options.showPanel },
      { label: preferences.expanded ? "收起详情" : "展开详情", click: () => nativeOperation(setExpanded(!preferences.expanded)) },
      { type: "separator" },
      { label: "隐藏金额", type: "checkbox", checked: preferences.privacy, click: () => nativeOperation(setPrivacy(!preferences.privacy)) },
      { label: "重置悬浮窗位置", click: () => {
        preferences.position = undefined;
        applyBounds();
        nativeOperation(persist());
      } },
      { label: "隐藏悬浮窗", click: () => nativeOperation(setEnabled(false)) },
    ]).popup({ window });
  }

  async function initializeWindow(): Promise<void> {
    if (!supported || disposed || !preferences.enabled) return;
    if (initializing) return initializing;
    if (window && !window.isDestroyed()) {
      applyBounds();
      window.showInactive();
      return;
    }
    initializing = (async () => {
      const initial = bounds();
      const companion = new BrowserWindow({
        ...initial,
        title: "悬浮窗 · 摸鱼时钟",
        icon: join(options.root, "assets", "icon.png"),
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        roundedCorners: true,
        backgroundColor: "#00000000",
        webPreferences: {
          preload: options.preload,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          backgroundThrottling: false,
          webSecurity: true,
        },
      });
      window = companion;
      expectedBounds = initial;
      companion.setMenu(null);
      companion.on("page-title-updated", (event) => event.preventDefault());
      // The drag surface is a native non-client area. Keep its system menu
      // suppressed; the explicit icon/menu button opens our application menu.
      companion.on("system-context-menu", (event) => event.preventDefault());
      companion.on("move", () => rememberMove());
      companion.on("moved", () => rememberMove(true));
      companion.on("close", (event) => {
        if (!quitting && !disposed) {
          event.preventDefault();
          nativeOperation(setEnabled(false));
        }
      });
      companion.on("closed", () => {
        if (window === companion) window = null;
      });
      companion.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      companion.webContents.on("will-attach-webview", (event) => event.preventDefault());
      companion.webContents.on("will-navigate", (event) => event.preventDefault());
      companion.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      companion.webContents.session.setPermissionCheckHandler(() => false);
      companion.once("ready-to-show", () => {
        if (!disposed && preferences.enabled) {
          applyBounds();
          companion.showInactive();
        }
      });
      if (options.devServer) {
        const url = new URL(options.devServer);
        if (!["http:", "https:"].includes(url.protocol) ||
          !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
          throw new Error("开发服务器必须使用本机地址。");
        url.searchParams.set("window", "floating");
        await companion.loadURL(url.toString());
      } else {
        await companion.loadFile(join(options.root, "dist", "index.html"), { query: { window: "floating" } });
      }
    })();
    try {
      await initializing;
    } catch (error) {
      window?.destroy();
      window = null;
      throw error;
    } finally {
      initializing = null;
    }
  }

  async function setEnabled(enabled: boolean): Promise<FloatingState> {
    if (typeof enabled !== "boolean") throw new Error("悬浮窗开关无效。");
    if (!supported) throw new Error("悬浮窗目前仅支持 Windows。");
    preferences.enabled = enabled;
    if (!enabled) window?.hide();
    publish();
    await Promise.all([persist(), enabled ? initializeWindow() : Promise.resolve()]);
    return getState();
  }

  async function setExpanded(expanded: boolean): Promise<FloatingState> {
    if (typeof expanded !== "boolean") throw new Error("悬浮窗展开设置无效。");
    preferences.expanded = expanded;
    applyBounds();
    publish();
    await persist();
    return getState();
  }

  async function setPrivacy(privacy: boolean): Promise<FloatingState> {
    if (typeof privacy !== "boolean") throw new Error("金额显示设置无效。");
    preferences.privacy = privacy;
    publish();
    await persist();
    return getState();
  }

  async function flush(): Promise<void> {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      settleMove();
      await persist();
    }
    await writeQueue;
    if (lastWriteError) throw new Error(`悬浮窗设置保存失败：${lastWriteError.message}`);
  }

  const invokeChannels = ["floating:get", "floating:enabled", "floating:expanded", "floating:privacy"];
  ipcMain.handle(invokeChannels[0], (event) => { assertSender(event); return getState(); });
  ipcMain.handle(invokeChannels[1], (event, enabled: boolean) => { assertSender(event); return setEnabled(enabled); });
  ipcMain.handle(invokeChannels[2], (event, expanded: boolean) => { assertSender(event); return setExpanded(expanded); });
  ipcMain.handle(invokeChannels[3], (event, privacy: boolean) => { assertSender(event); return setPrivacy(privacy); });
  const onOpen = (event: IpcMainEvent) => { if (options.isMainSender(event) || isSender(event)) options.showPanel(); };
  const onMenu = (event: IpcMainEvent) => { if (isSender(event)) menu(); };
  ipcMain.on("floating:open", onOpen);
  ipcMain.on("floating:menu", onMenu);
  const onQuit = (event: Electron.Event) => { if (!event.defaultPrevented) quitting = true; };
  app.on("before-quit", onQuit);
  screen.on("display-added", recoverPosition);
  screen.on("display-removed", recoverPosition);
  screen.on("display-metrics-changed", recoverPosition);

  return {
    getWindow: () => window,
    isSender,
    getState,
    setEnabled,
    setExpanded,
    setPrivacy,
    initializeWindow,
    flush,
    dispose: () => {
      disposed = true;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = undefined;
      for (const channel of invokeChannels) ipcMain.removeHandler(channel);
      ipcMain.removeListener("floating:open", onOpen);
      ipcMain.removeListener("floating:menu", onMenu);
      app.removeListener("before-quit", onQuit);
      screen.removeListener("display-added", recoverPosition);
      screen.removeListener("display-removed", recoverPosition);
      screen.removeListener("display-metrics-changed", recoverPosition);
      window?.destroy();
      window = null;
    },
  };
}

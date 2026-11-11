import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
} from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent, Rectangle } from "electron";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { normalizeData, type AppData } from "../src/core";
import { createUpdaterController } from "./updater";

const WIDTH = 440;
const HEIGHT = 680;
const GAP = 10;
const MAX_STATE_BYTES = 4 * 1024 * 1024;
const root = join(__dirname, "..");
const devServer = process.env.VITE_DEV_SERVER_URL;
const keepOpen = process.env.TOUCHFISH_KEEP_OPEN === "1";

if (process.env.TOUCHFISH_USER_DATA)
  app.setPath("userData", resolve(process.env.TOUCHFISH_USER_DATA));
app.setName("摸鱼时钟");
app.setAppUserModelId("com.touchfish.clock");

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitAllowed = false;
let quitPending = false;
let lastBlur = 0;
let lastBlurOverTray = false;
let settingsPending = false;
let writeQueue: Promise<void> = Promise.resolve();
let lastWriteError: Error | null = null;
let updater: ReturnType<typeof createUpdaterController> | null = null;

function updateController() {
  if (!updater) throw new Error("更新服务尚未就绪。");
  return updater;
}

function trustedSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return (
    !!win &&
    event.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame
  );
}

function assertTrusted(event: IpcMainInvokeEvent): void {
  if (!trustedSender(event)) throw new Error("无法识别的应用请求。");
}

function statePaths() {
  const directory = app.getPath("userData");
  return {
    directory,
    state: join(directory, "state.json"),
    backup: join(directory, "state.backup.json"),
    temporary: join(directory, "state.tmp.json"),
  };
}

function parseState(contents: string): AppData {
  const value = JSON.parse(contents);
  if (
    !value ||
    value.version !== 1 ||
    typeof value.settings !== "object" ||
    !value.settings ||
    Array.isArray(value.settings) ||
    typeof value.records !== "object" ||
    !value.records ||
    Array.isArray(value.records)
  ) {
    throw new Error("数据格式无法识别。");
  }
  return normalizeData(value);
}

async function loadState(): Promise<AppData | null> {
  const { state, backup } = statePaths();
  let originalError: unknown;
  try {
    return parseState(await readFile(state, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        return parseState(await readFile(backup, "utf8"));
      } catch (backupError) {
        if ((backupError as NodeJS.ErrnoException).code === "ENOENT")
          return null;
        throw new Error("备用数据无法读取，请检查应用数据目录。");
      }
    }
    originalError = error;
  }
  try {
    const data = parseState(await readFile(backup, "utf8"));
    // Restore a readable primary file before another save can rotate the backup.
    await copyFile(backup, state);
    return data;
  } catch {
    throw new Error(
      `本地数据读取失败，原文件已保留：${originalError instanceof Error ? originalError.message : "未知错误"}`,
    );
  }
}

function saveState(value: unknown): Promise<void> {
  const text = JSON.stringify(value);
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES
  )
    return Promise.reject(new Error("本地数据过大，无法保存。"));
  let data: AppData;
  try {
    data = parseState(text);
  } catch {
    return Promise.reject(new Error("数据格式不正确，未覆盖已保存的记录。"));
  }
  const normalizedText = JSON.stringify(data, null, 2);
  const operation = writeQueue.then(async () => {
    const { directory, state, backup, temporary } = statePaths();
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, normalizedText, {
      encoding: "utf8",
      mode: 0o600,
      flush: true,
    });
    try {
      // Only rotate a valid state into the recovery file.
      parseState(await readFile(state, "utf8"));
      await copyFile(state, backup);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        !(error instanceof SyntaxError) &&
        (error as NodeJS.ErrnoException).code
      )
        throw error;
    }
    await rename(temporary, state);
    lastWriteError = null;
  });
  // Keep subsequent writes usable after a failed disk operation.
  writeQueue = operation.catch((error: Error) => {
    lastWriteError = error;
  });
  return operation.catch((error: Error) => {
    throw new Error(`保存失败：${error.message}`);
  });
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, Math.max(low, high)));
}

function pointerOverTray(): boolean {
  const icon = tray?.getBounds();
  if (!icon || icon.width <= 0 || icon.height <= 0) return false;
  const point = screen.getCursorScreenPoint();
  return (
    point.x >= icon.x &&
    point.x <= icon.x + icon.width &&
    point.y >= icon.y &&
    point.y <= icon.y + icon.height
  );
}

/** Position against the actual tray edge, including side/top taskbars and negative monitor coordinates. */
function popupBounds(): Rectangle {
  const icon = tray?.getBounds();
  const hasIcon = !!icon && icon.width > 0 && icon.height > 0;
  const cursor = screen.getCursorScreenPoint();
  const anchor = hasIcon
    ? { x: icon.x + icon.width / 2, y: icon.y + icon.height / 2 }
    : cursor;
  const display = screen.getDisplayNearestPoint(anchor);
  const area = display.workArea;
  const width = Math.min(WIDTH, area.width);
  const height = Math.min(HEIGHT, area.height);
  let x = area.x + area.width - width - GAP;
  let y = area.y + area.height - height - GAP;
  if (hasIcon) {
    const bounds = display.bounds;
    const distances = [
      {
        edge: "top",
        distance: Math.abs(anchor.y - bounds.y),
        inset: area.y - bounds.y,
        outside: anchor.y < area.y,
      },
      {
        edge: "bottom",
        distance: Math.abs(bounds.y + bounds.height - anchor.y),
        inset: bounds.y + bounds.height - area.y - area.height,
        outside: anchor.y >= area.y + area.height,
      },
      {
        edge: "left",
        distance: Math.abs(anchor.x - bounds.x),
        inset: area.x - bounds.x,
        outside: anchor.x < area.x,
      },
      {
        edge: "right",
        distance: Math.abs(bounds.x + bounds.width - anchor.x),
        inset: bounds.x + bounds.width - area.x - area.width,
        outside: anchor.x >= area.x + area.width,
      },
    ];
    // A corner tray is often closer to the neighbouring screen edge than its own
    // taskbar edge. Prefer the reserved taskbar strip before distance fallback.
    const reserved = distances.filter(
      (edge) =>
        edge.inset > 0 &&
        (edge.outside ||
          edge.distance <= edge.inset + icon.height + icon.width),
    );
    const candidates = reserved.length ? reserved : distances;
    candidates.sort(
      (a, b) =>
        Number(b.outside) - Number(a.outside) || a.distance - b.distance,
    );
    switch (candidates[0].edge) {
      case "top":
        x = anchor.x - width / 2;
        y = Math.max(area.y + GAP, icon.y + icon.height + GAP);
        break;
      case "bottom":
        x = anchor.x - width / 2;
        y = Math.min(
          area.y + area.height - height - GAP,
          icon.y - height - GAP,
        );
        break;
      case "left":
        x = Math.max(area.x + GAP, icon.x + icon.width + GAP);
        y = anchor.y - height / 2;
        break;
      case "right":
        x = Math.min(area.x + area.width - width - GAP, icon.x - width - GAP);
        y = anchor.y - height / 2;
        break;
    }
  }
  return {
    x: Math.round(clamp(x, area.x, area.x + area.width - width)),
    y: Math.round(clamp(y, area.y, area.y + area.height - height)),
    width,
    height,
  };
}

function showWindow(settings = false): void {
  if (!win || win.isDestroyed()) return;
  if (settings) settingsPending = true;
  win.setBounds(popupBounds());
  win.show();
  win.focus();
  if (!win.webContents.isLoadingMainFrame() && settingsPending) {
    settingsPending = false;
    win.webContents.send("window:settings");
  }
}

async function requestQuit(): Promise<void> {
  if (quitPending) return;
  quitPending = true;
  await writeQueue;
  if (lastWriteError) {
    dialog.showErrorBox(
      "本地数据保存失败",
      `请检查磁盘空间和应用目录权限。最近一次错误：${lastWriteError.message}\n已保存的记录仍保留在本机。`,
    );
  }
  quitAllowed = true;
  app.quit();
}

function registerIpc(): void {
  ipcMain.handle("updater:get", (event) => {
    assertTrusted(event);
    return updateController().getState();
  });
  ipcMain.handle("updater:check", (event) => {
    assertTrusted(event);
    return updateController().check();
  });
  ipcMain.handle("updater:download", (event) => {
    assertTrusted(event);
    return updateController().download();
  });
  ipcMain.handle("updater:open-release", (event) => {
    assertTrusted(event);
    return updateController().openReleasePage();
  });
  ipcMain.handle("updater:install", async (event) => {
    assertTrusted(event);
    try {
      await updateController().install();
    } catch (error) {
      quitAllowed = false;
      throw error;
    }
  });
  ipcMain.handle("data:load", async (event) => {
    assertTrusted(event);
    await writeQueue;
    return loadState();
  });
  ipcMain.handle("data:save", (event, value: unknown) => {
    assertTrusted(event);
    return saveState(value);
  });
  ipcMain.handle("login:get", (event) => {
    assertTrusted(event);
    if (process.platform === "linux") return false;
    return app.getLoginItemSettings(
      process.platform === "win32"
        ? { path: process.execPath, args: ["--hidden"] }
        : {},
    ).openAtLogin;
  });
  ipcMain.handle("login:set", (event, enabled: unknown) => {
    assertTrusted(event);
    if (typeof enabled !== "boolean") throw new Error("开机启动设置无效。");
    if (process.platform === "linux")
      throw new Error("请在 Linux 桌面环境的启动应用中添加摸鱼时钟。");
    if (!app.isPackaged && enabled)
      throw new Error("开机启动可在安装正式版后开启。");
    app.setLoginItemSettings(
      process.platform === "win32"
        ? { openAtLogin: enabled, path: process.execPath, args: ["--hidden"] }
        : { openAtLogin: enabled },
    );
    const actual = app.getLoginItemSettings(
      process.platform === "win32"
        ? { path: process.execPath, args: ["--hidden"] }
        : {},
    );
    if (actual.openAtLogin !== enabled)
      throw new Error(
        "系统尚未应用开机启动设置，请在系统的登录项设置中检查摸鱼时钟。",
      );
  });
  ipcMain.on("window:hide", (event) => {
    if (trustedSender(event)) win?.hide();
  });
  ipcMain.on("app:quit", (event) => {
    if (trustedSender(event)) void requestQuit();
  });
  ipcMain.on("tray:status", (event, message: unknown) => {
    if (trustedSender(event) && typeof message === "string")
      tray?.setToolTip(message.slice(0, 120));
  });
}

async function createWindow(): Promise<void> {
  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    backgroundColor: "#00000000",
    title: "摸鱼时钟",
    icon: join(root, "assets", "icon.png"),
    roundedCorners: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      webSecurity: true,
    },
  });
  win.setMenu(null);
  win.on("blur", () => {
    if (keepOpen) return;
    lastBlur = Date.now();
    // A programmatic hide can emit blur after the click handler. Only a blur
    // from a still-visible popup belongs to a fresh tray click.
    lastBlurOverTray = !!win?.isVisible() && pointerOverTray();
    win?.hide();
  });
  win.on("close", (event) => {
    if (!quitAllowed) {
      event.preventDefault();
      win?.hide();
    }
  });
  win.on("closed", () => {
    win = null;
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.webContents.on("will-navigate", (event, target) => {
    if (!devServer || target !== devServer) event.preventDefault();
  });
  win.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.webContents.on("did-finish-load", () => {
    if (settingsPending) {
      settingsPending = false;
      win?.webContents.send("window:settings");
    }
  });
  win.once("ready-to-show", () => {
    const loginLaunch =
      process.platform === "darwin" &&
      app.getLoginItemSettings().wasOpenedAtLogin;
    if (!process.argv.includes("--hidden") && !loginLaunch) showWindow();
  });
  if (devServer) {
    const url = new URL(devServer);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      throw new Error("开发服务器必须使用本机地址。");
    await win.loadURL(devServer);
  } else {
    await win.loadFile(join(root, "dist", "index.html"));
  }
}

function createTray(): void {
  const iconPath = join(
    root,
    "assets",
    process.platform === "darwin" ? "trayTemplate.png" : "tray.png",
  );
  const icon = nativeImage.createFromPath(iconPath);
  if (process.platform === "darwin") icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("摸鱼时钟 · 让每一秒都有回报");
  const contextMenu = Menu.buildFromTemplate([
    { label: "打开摸鱼时钟", click: () => showWindow() },
    { label: "偏好设置", click: () => showWindow(true) },
    {
      label: "检查应用更新",
      click: () => {
        showWindow(true);
        void updateController()
          .check()
          .catch(() => {});
      },
    },
    { type: "separator" },
    { label: "退出", click: () => void requestQuit() },
  ]);
  if (process.platform === "linux") tray.setContextMenu(contextMenu);
  else tray.on("right-click", () => tray?.popUpContextMenu(contextMenu));
  tray.on("click", () => {
    const justClosedByTray = lastBlurOverTray && Date.now() - lastBlur < 600;
    lastBlurOverTray = false;
    if (win?.isVisible() || justClosedByTray) win?.hide();
    else showWindow();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.on("activate", () => showWindow());
  app.on("before-quit", (event) => {
    if (!quitAllowed) {
      event.preventDefault();
      void requestQuit();
    }
  });
  app.on("window-all-closed", () => {
    /* A tray app remains active without visible windows. */
  });
  app.on("will-quit", () => {
    updater?.dispose();
    tray?.destroy();
    tray = null;
  });
  app
    .whenReady()
    .then(async () => {
      if (process.platform === "darwin") app.dock?.hide();
      updater = createUpdaterController({
        onState: (state) => {
          if (state.status === "error") quitAllowed = false;
          if (win && !win.isDestroyed() && !win.webContents.isDestroyed())
            win.webContents.send("updater:state", state);
        },
        beforeInstall: async () => {
          await writeQueue;
          if (lastWriteError)
            throw new Error("工作记录尚未保存，请先重试保存，再安装更新。");
          quitAllowed = true;
        },
        quitForManualInstall: () => {
          app.quit();
        },
      });
      registerIpc();
      createTray();
      await createWindow();
    })
    .catch((error: Error) => {
      dialog.showErrorBox("摸鱼时钟启动失败", error.message);
      quitAllowed = true;
      app.quit();
    });
}

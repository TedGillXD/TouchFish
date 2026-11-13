import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  screen,
  session,
  shell,
  Tray,
} from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent, Rectangle } from "electron";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { emptyData, normalizeData, type AppData } from "../src/core";
import { createDataManagement } from "./data-management";
import { createDataBackup, type DataBackup, type BackupPreferences } from "./data-backup-policy";
import { createUpdaterController } from "./updater";
import { createFloatingController } from "./floating-window";
import { createHolidayService } from "./holiday-service";
import { createBilibiliService } from "./bilibili-service";
import { createBilibiliWindow } from "./bilibili-window";
import { createBilibiliHistory } from "./bilibili-history";
import { normalizeBvid } from "./bilibili-policy";
import { createBossKeyController } from "./boss-key";
import { createYouTubeWindow } from "./youtube-window";
import type { BiliMode, BiliPlayback, BiliPlayRequest, BiliTransportState } from "../src/bilibili-types";
import type { BossKeyState } from "../src/boss-key-types";
import type { MediaProvider, MediaTransportState } from "../src/media-types";
import type { YouTubeBrowser, YouTubePlayerState } from "../src/youtube-types";

protocol.registerSchemesAsPrivileged([{
  scheme: "touchfish-media",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

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
if (process.platform === "linux") app.setDesktopName("com.touchfish.clock.desktop");

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitAllowed = false;
let quitPending = false;
let lastBlur = 0;
let lastBlurOverTray = false;
let settingsPending = false;
let writeQueue: Promise<void> = Promise.resolve();
let lastWriteError: Error | null = null;
let liveData: AppData | null = null;
let updater: ReturnType<typeof createUpdaterController> | null = null;
let floating: Awaited<ReturnType<typeof createFloatingController>> | null = null;
let holidays: Awaited<ReturnType<typeof createHolidayService>> | null = null;
let bilibili: Awaited<ReturnType<typeof createBilibiliService>> | null = null;
let biliHistory: Awaited<ReturnType<typeof createBilibiliHistory>> | null = null;
let historyClearVersion = 0;
const historyDeletionVersions = new Map<string, number>();
let player: ReturnType<typeof createBilibiliWindow> | null = null;
let playbackRequest = 0;
let youtube: Awaited<ReturnType<typeof createYouTubeWindow>> | null = null;
let bossKey: Awaited<ReturnType<typeof createBossKeyController>> | null = null;
let dataManagement: Awaited<ReturnType<typeof createDataManagement>> | null = null;
let importingData = false;
let awaitingRestoredDocument = false;
let mainDataSession: string | null = null;
let dataDialogOpen = false;
let leisureSuppressed = false;
let leisureEpoch = 0;
let concealedMain: boolean | null = null;
let activeProvider: MediaProvider | null = null;
let lastBiliIntent = false;
let lastYouTubeIntent = false;

const extensionDirectory = app.isPackaged
  ? join(process.resourcesPath, "youtube-companion")
  : join(root, "extensions", "youtube-companion");

function currentMediaState(): MediaTransportState {
  const bili = player?.getTransportState();
  const yt = youtube?.getTransportState();
  const provider = activeProvider === "youtube" && yt?.open ? "youtube"
    : activeProvider === "bilibili" && bili?.open ? "bilibili"
      : yt?.open ? "youtube" : bili?.open ? "bilibili" : null;
  activeProvider = provider;
  const state = provider === "youtube" ? yt : provider === "bilibili" ? bili : null;
  return state ? { ...state, provider } : {
    provider: null, open: false, revision: 0, ready: false, playing: false,
    playIntent: false, buffering: false, ended: false, failed: false,
  };
}

function sendCompanion(channel: string, value: unknown) {
  const companion = floating?.getWindow();
  if (companion && !companion.isDestroyed() && !companion.webContents.isDestroyed()) {
    try { companion.webContents.send(channel, value); } catch { /* Reload reads a snapshot. */ }
  }
}

function broadcastCurrentMedia() {
  const state = currentMediaState();
  floating?.setMediaActive(state.open);
  broadcastMedia("media:transport-state", state);
  sendCompanion("media:transport-state", state);
}

function onYouTubeState(state: YouTubePlayerState) {
  sendMain("youtube:state", state);
  broadcastCurrentMedia();
}

function onYouTubeTransport(state: BiliTransportState) {
  if (state.playIntent && !lastYouTubeIntent && !leisureSuppressed) {
    activeProvider = "youtube";
    const other = player?.getTransportState();
    if (other?.ready && other.playIntent) void player?.setPlaying(false, other.revision).catch(() => {});
  }
  lastYouTubeIntent = state.playIntent;
  sendMain("youtube:transport-state", state);
  broadcastCurrentMedia();
}

async function concealLeisure(): Promise<void> {
  leisureSuppressed = true;
  leisureEpoch++;
  playbackRequest++;
  if (concealedMain === null) concealedMain = win?.isVisible() ?? false;
  win?.hide();
  floating?.setConcealed(true);
  bilibili?.cancelLogin();
  const results = await Promise.allSettled([player?.pauseAndHide(), youtube?.pauseAndHide()]);
  if (results.some(result => result.status === "rejected"))
    throw new Error("部分媒体未确认暂停，窗口已要求收起。");
}

function repeatConcealLeisure(): void {
  leisureSuppressed = true;
  leisureEpoch++;
  playbackRequest++;
  win?.hide();
  floating?.setConcealed(true);
  void player?.pauseAndHide().catch(() => {});
  void youtube?.pauseAndHide().catch(() => {});
}

async function restoreLeisure(): Promise<void> {
  const epoch = leisureEpoch;
  await Promise.all([player?.restorePaused(), youtube?.restorePaused()]);
  if (epoch !== leisureEpoch) return;
  leisureSuppressed = false;
  floating?.setConcealed(false);
  if (concealedMain) showWindow();
  concealedMain = null;
}

function assertLeisureAvailable() {
  if (leisureSuppressed) throw new Error("摸鱼窗口已收起，请先从托盘恢复窗口。");
}

function mediaController() {
  if (!bilibili) throw new Error("B 站服务尚未就绪。");
  return bilibili;
}

function historyController() {
  if (!biliHistory) throw new Error("视频记录暂未就绪，请稍后重试。");
  return biliHistory;
}

function assertMediaSender(event: IpcMainInvokeEvent): void {
  if (!trustedSender(event) && !player?.isSender(event))
    throw new Error("无法识别的播放器请求。");
}

function assertTransportSender(event: IpcMainInvokeEvent): void {
  if (!trustedSender(event) && !player?.isSender(event) && !floating?.isSender(event))
    throw new Error("无法识别的播放控制请求。");
}

function broadcastTransport(state: BiliTransportState): void {
  // Size the native companion before its renderer receives a new media button.
  if (state.playIntent && !lastBiliIntent && !leisureSuppressed) {
    activeProvider = "bilibili";
    const other = youtube?.getTransportState();
    if (other?.ready && other.playIntent) void youtube?.setPlaying(false, other.revision).catch(() => {});
  }
  lastBiliIntent = state.playIntent;
  broadcastMedia("bilibili:transport-state", state);
  sendCompanion("bilibili:transport-state", state);
  broadcastCurrentMedia();
}

function broadcastMedia(channel: string, value: unknown): void {
  for (const window of [win, player?.getWindow()]) {
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
      try { window.webContents.send(channel, value); } catch { /* Reload obtains a fresh snapshot. */ }
    }
  }
}

function sendMain(channel: string, value: unknown): void {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    try { win.webContents.send(channel, value); } catch { /* Reload reads a fresh snapshot. */ }
  }
}

async function playBilibili(input: unknown, activate = true): Promise<BiliPlayback> {
  assertLeisureAvailable();
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("播放参数无效。");
  const request = input as BiliPlayRequest;
  if (typeof request.bvid !== "string" || request.bvid.length > 512 ||
    !["audio", "video"].includes(request.mode) ||
    (request.cid !== undefined && (!Number.isSafeInteger(request.cid) || request.cid <= 0)) ||
    (request.quality !== undefined && (!Number.isInteger(request.quality) || request.quality < 1 || request.quality > 200)))
    throw new Error("播放参数无效，请检查 BV 号、分 P 和画质。");
  const revision = ++playbackRequest;
  const bvid = normalizeBvid(request.bvid);
  const clearVersion = historyClearVersion;
  const deletionVersion = historyDeletionVersions.get(bvid) ?? 0;
  const playback = await mediaController().resolvePlayback(request);
  if (revision !== playbackRequest) throw new Error("已切换至另一个播放请求。");
  assertLeisureAvailable();
  activeProvider = "bilibili";
  await player!.open(playback, activate);
  // Deleting a record while its media request is in flight must stay deleted.
  if (clearVersion === historyClearVersion && deletionVersion === (historyDeletionVersions.get(bvid) ?? 0))
    await biliHistory?.recordPlay(playback, activate).catch(() => {});
  return playback;
}

function holidayController() {
  if (!holidays) throw new Error("节假日服务尚未就绪。");
  return holidays;
}

function assertReadable(event: IpcMainInvokeEvent): void {
  if (!trustedSender(event) && !floating?.isSender(event))
    throw new Error("无法识别的应用请求。");
}

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
  // The main renderer owns the active session. A disk failure must not leave
  // the read-only companion counting an interval that was already paused.
  liveData = data;
  const floatingWindow = floating?.getWindow();
  if (floatingWindow && !floatingWindow.isDestroyed() && !floatingWindow.webContents.isDestroyed()) {
    try {
      floatingWindow.webContents.send("data:changed", data);
    } catch {
      // Reloading the companion obtains liveData; notification failures must
      // never prevent the work record from reaching the disk queue.
    }
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

function portablePreferences(): BackupPreferences {
  const state = floating?.getState();
  return {
    ...(bossKey ? { bossShortcut: bossKey.getState().shortcut } : {}),
    ...(state ? { floating: { enabled: state.enabled, expanded: state.expanded, privacy: state.privacy } } : {}),
  };
}

async function captureDataBackup(): Promise<DataBackup> {
  await writeQueue;
  await biliHistory?.flush().catch(() => {});
  await bossKey?.flush();
  await floating?.flush();
  const history = biliHistory?.getState();
  if (history?.error) throw new Error("视频历史尚未完整读取或保存，请先处理历史记录错误后再备份。");
  return createDataBackup({
    appVersion: app.getVersion(), data: liveData ?? await loadState() ?? emptyData(),
    history: history?.entries ?? [], preferences: portablePreferences(),
  });
}

async function applyPortablePreferences(value?: BackupPreferences): Promise<void> {
  if (!value) return;
  if (value.bossShortcut !== undefined) await bossKey?.setShortcut(value.bossShortcut);
  if (value.floating && floating) {
    await floating.setPrivacy(value.floating.privacy);
    await floating.setExpanded(value.floating.expanded);
    if (floating.getState().supported) await floating.setEnabled(value.floating.enabled);
  }
}

async function applyDataBackup(backup: DataBackup): Promise<void> {
  if (importingData) throw new Error("数据正在恢复，请稍后重试。");
  importingData = true;
  awaitingRestoredDocument = false;
  let before: { data: AppData; history: ReturnType<NonNullable<typeof biliHistory>["getState"]>["entries"]; preferences: BackupPreferences } | null = null;
  try {
    await writeQueue;
    await biliHistory?.flush().catch(() => {});
    before = {
      data: structuredClone(liveData ?? await loadState() ?? emptyData()),
      history: biliHistory?.getState().entries ?? [], preferences: portablePreferences(),
    };
    historyClearVersion++;
    historyDeletionVersions.clear();
    await applyPortablePreferences(backup.preferences);
    if (backup.history !== undefined) await biliHistory?.replace(backup.history);
    await saveState(backup.data);
    awaitingRestoredDocument = true;
    // A new document receives the imported snapshot. Its private session ID
    // also prevents a late autosave from the old React draft overwriting it.
    setImmediate(() => {
      if (quitPending) return;
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.reload();
    });
  } catch {
    let rollbackFailed = false;
    if (before) {
      for (const restore of [
        () => applyPortablePreferences(before!.preferences),
        () => backup.history !== undefined ? biliHistory?.replace(before!.history) : Promise.resolve(),
        () => saveState(before!.data),
      ]) {
        try { await restore(); } catch { rollbackFailed = true; }
      }
    }
    importingData = false;
    awaitingRestoredDocument = false;
    throw new Error(rollbackFailed
      ? "恢复未完成，部分写入未能回退；导入前的恢复副本已保留，请检查磁盘权限后使用恢复导入前数据。"
      : "恢复未完成，原有数据已保留。若快捷键被占用，可取消恢复偏好设置后重试。");
  }
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
  // Network sync can be canceled; local restore/export writes still finish in flush.
  dataManagement?.dispose();
  await writeQueue;
  await holidays?.flush().catch(() => {});
  await bilibili?.flush().catch(() => {});
  await biliHistory?.flush().catch(() => {});
  await youtube?.pauseAndHide().catch(() => {});
  await youtube?.flush().catch(() => {});
  await bossKey?.flush().catch(() => {});
  await dataManagement?.flush().catch(() => {});
  try {
    await floating?.flush();
  } catch {
    dialog.showErrorBox("悬浮窗设置保存失败", "本次窗口位置可能无法保留，请检查应用数据目录权限。");
  }
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
  const manager = () => {
    if (!dataManagement) throw new Error("数据管理尚未就绪，请稍后重试。");
    return dataManagement;
  };
  ipcMain.handle("backup:get", event => { assertTrusted(event); return manager().getState(); });
  ipcMain.handle("backup:export", event => { assertTrusted(event); return manager().exportBackup(); });
  ipcMain.handle("backup:preview-file", event => { assertTrusted(event); return manager().previewImport(); });
  ipcMain.handle("backup:preview-remote", event => { assertTrusted(event); return manager().previewRemote(); });
  ipcMain.handle("backup:preview-recovery", event => { assertTrusted(event); return manager().previewRecovery(); });
  ipcMain.handle("backup:restore", (event, id: unknown, preferences: unknown = true) => { assertTrusted(event); return manager().restorePreview(id, preferences); });
  ipcMain.handle("backup:cancel", (event, id: unknown) => { assertTrusted(event); return manager().cancelPreview(id); });
  ipcMain.handle("backup:git-configure", (event, config) => { assertTrusted(event); return manager().configureGit(config); });
  ipcMain.handle("backup:git-check", event => { assertTrusted(event); return manager().checkGit(); });
  ipcMain.handle("backup:git-upload", event => { assertTrusted(event); return manager().uploadGit(); });
  ipcMain.handle("boss-key:get", event => { assertTrusted(event); return bossKey!.getState(); });
  ipcMain.handle("boss-key:set-shortcut", (event, shortcut: unknown) => { assertTrusted(event); return bossKey!.setShortcut(shortcut); });
  ipcMain.handle("boss-key:trigger", event => {
    if (!trustedSender(event) && !player?.isSender(event) && !floating?.isSender(event))
      throw new Error("无法识别的老板键请求。");
    return bossKey!.trigger();
  });
  ipcMain.handle("boss-key:restore", event => { assertTrusted(event); return bossKey!.restore(); });
  ipcMain.handle("media:transport-state", event => { assertTransportSender(event); return currentMediaState(); });
  ipcMain.handle("media:set-playing", (event, playing: unknown, revision: unknown, provider: unknown) => {
    assertTransportSender(event);
    if (typeof playing !== "boolean" || !Number.isSafeInteger(revision) || (provider !== "bilibili" && provider !== "youtube"))
      throw new Error("播放控制参数无效。");
    if (playing) assertLeisureAvailable();
    if (currentMediaState().provider !== provider) throw new Error("当前媒体已切换，请重试。");
    return provider === "youtube" ? youtube!.setPlaying(playing, Number(revision)) : player!.setPlaying(playing, revision);
  });
  const youtubeController = () => {
    if (!youtube) throw new Error("YouTube 浏览器连接暂不可用，请重启后重试。");
    return youtube;
  };
  ipcMain.handle("youtube:get", event => { assertTrusted(event); return youtubeController().getState(); });
  ipcMain.handle("youtube:connect", (event, browser: YouTubeBrowser) => {
    assertTrusted(event); assertLeisureAvailable();
    return youtubeController().connectBrowser(browser);
  });
  ipcMain.handle("youtube:open", async (event, input: unknown) => {
    assertTrusted(event); assertLeisureAvailable();
    if (typeof input !== "string") throw new Error("请输入 YouTube 视频链接或编号。");
    const epoch = leisureEpoch;
    activeProvider = "youtube";
    const state = await youtubeController().open(input);
    if (epoch !== leisureEpoch || leisureSuppressed) {
      await youtubeController().pauseAndHide();
      throw new Error("摸鱼窗口已收起，本次播放已取消。");
    }
    return state;
  });
  ipcMain.handle("youtube:transport-state", event => { assertTrusted(event); return youtubeController().getTransportState(); });
  ipcMain.handle("youtube:set-playing", (event, playing: unknown, revision: unknown) => {
    assertTrusted(event);
    if (typeof playing !== "boolean" || !Number.isSafeInteger(revision)) throw new Error("播放控制参数无效。");
    if (playing) assertLeisureAvailable();
    return youtubeController().setPlaying(playing, Number(revision));
  });
  ipcMain.handle("youtube:volume", (event, volume: number) => { assertTrusted(event); return youtubeController().setVolume(volume); });
  ipcMain.handle("youtube:rate", (event, rate: number) => { assertTrusted(event); return youtubeController().setPlaybackRate(rate); });
  ipcMain.handle("youtube:open-browser", (event, input?: string) => { assertTrusted(event); assertLeisureAvailable(); return youtubeController().openInBrowser(input); });
  ipcMain.handle("youtube:login", event => { assertTrusted(event); assertLeisureAvailable(); return youtubeController().openLogin(); });
  ipcMain.handle("youtube:extension-folder", event => { assertTrusted(event); return shell.openPath(extensionDirectory).then(error => { if (error) throw new Error("扩展文件夹暂时无法打开。"); }); });
  for (const [channel, action] of [
    ["youtube:show", () => { assertLeisureAvailable(); youtubeController().show(); }],
    ["youtube:minimize", () => youtubeController().minimize()],
    ["youtube:close", () => youtubeController().close()],
  ] as const) ipcMain.on(channel, event => { if (trustedSender(event)) { try { action(); } catch { /* UI obtains the next state. */ } } });
  ipcMain.handle("bilibili:auth", (event) => { assertMediaSender(event); return mediaController().getAuth(); });
  ipcMain.handle("bilibili:history-get", event => { assertTrusted(event); return historyController().getState(); });
  ipcMain.handle("bilibili:history-remove", (event, input: unknown) => {
    assertTrusted(event);
    const bvid = normalizeBvid(input);
    historyDeletionVersions.set(bvid, (historyDeletionVersions.get(bvid) ?? 0) + 1);
    return historyController().remove(bvid);
  });
  ipcMain.handle("bilibili:history-clear", event => {
    assertTrusted(event);
    historyClearVersion++;
    historyDeletionVersions.clear();
    return historyController().clear();
  });
  ipcMain.handle("bilibili:qr", (event) => { assertTrusted(event); assertLeisureAvailable(); return mediaController().createQr(); });
  ipcMain.handle("bilibili:cancel-login", (event) => { assertTrusted(event); mediaController().cancelLogin(); });
  ipcMain.handle("bilibili:logout", async (event) => {
    assertTrusted(event);
    playbackRequest++;
    player?.close();
    return mediaController().logout();
  });
  ipcMain.handle("bilibili:video", async (event, input: unknown) => {
    assertMediaSender(event);
    if (typeof input !== "string" || input.length > 512) throw new Error("请输入有效的 BV 号。");
    const bvid = normalizeBvid(input);
    if (trustedSender(event)) await biliHistory?.recordSearch(bvid).catch(() => {});
    const video = await mediaController().getVideo(bvid);
    if (trustedSender(event)) await biliHistory?.recordVideo(video).catch(() => {});
    return video;
  });
  ipcMain.handle("bilibili:play", (event, request: unknown) => { assertMediaSender(event); return playBilibili(request, trustedSender(event)); });
  ipcMain.handle("bilibili:playback", (event) => { assertMediaSender(event); return player?.getPlayback() ?? null; });
  ipcMain.handle("bilibili:player-state", (event) => { assertMediaSender(event); return player!.getState(); });
  ipcMain.handle("bilibili:transport-state", event => { assertTransportSender(event); return player!.getTransportState(); });
  ipcMain.handle("bilibili:set-playing", (event, playing: unknown, revision: unknown) => {
    assertTransportSender(event);
    if (playing === true) assertLeisureAvailable();
    return player!.setPlaying(playing, revision);
  });
  ipcMain.on("bilibili:transport-report", (event, state: unknown, commandId: unknown) => {
    if (player?.isSender(event)) player.reportTransportState(state, commandId);
  });
  ipcMain.handle("bilibili:mode", (event, mode: BiliMode) => {
    assertMediaSender(event);
    const current = player?.getPlayback();
    if (!current || !["audio", "video"].includes(mode)) throw new Error("请先打开一个视频。");
    return playBilibili({ bvid: current.video.bvid, cid: current.cid, quality: current.quality, mode }, trustedSender(event));
  });
  ipcMain.handle("bilibili:danmaku", (event, cid: unknown) => {
    assertMediaSender(event);
    if (!Number.isSafeInteger(cid) || Number(cid) <= 0 || player?.getPlayback()?.cid !== cid)
      throw new Error("弹幕请求无效。");
    return mediaController().getDanmaku(cid as number);
  });
  ipcMain.handle("bilibili:open-page", (event) => {
    assertMediaSender(event);
    const bvid = player?.getPlayback()?.video.bvid;
    if (!bvid || !/^BV[0-9A-Za-z]{10}$/.test(bvid)) throw new Error("请先选择一个视频。");
    return shell.openExternal(`https://www.bilibili.com/video/${bvid}/`);
  });
  for (const [channel, operation] of [
    ["bilibili:close", () => { playbackRequest++; player?.close(); }],
    ["bilibili:minimize", () => player?.minimize()],
    ["bilibili:show", () => player?.show()],
  ] as const) ipcMain.on(channel, event => {
    if (trustedSender(event) || player?.isSender(event)) operation();
  });
  ipcMain.handle("holidays:get", (event) => {
    assertReadable(event);
    return holidayController().getState();
  });
  ipcMain.handle("holidays:refresh", (event, years: unknown, force: unknown) => {
    assertReadable(event);
    if (years !== undefined && (!Array.isArray(years) || years.length > 8 ||
      years.some((year) => !Number.isInteger(year) || year < 1900 || year > 2299)))
      throw new Error("请求的节假日年份无效。");
    if (force !== undefined && typeof force !== "boolean")
      throw new Error("节假日刷新设置无效。");
    return holidayController().refresh(years as number[] | undefined, force as boolean | undefined);
  });
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
  ipcMain.handle("data:load", async (event, session: unknown) => {
    const isFloating = floating?.isSender(event);
    if (!trustedSender(event) && !isFloating)
      throw new Error("无法识别的应用请求。");
    if (trustedSender(event)) {
      if (typeof session !== "string" || !/^[a-f0-9-]{36}$/i.test(session)) throw new Error("数据会话无效，请重新打开面板。");
      if (importingData && (!awaitingRestoredDocument || session === mainDataSession)) throw new Error("数据正在恢复，请等待面板重新加载。");
      mainDataSession = session;
      if (awaitingRestoredDocument) { awaitingRestoredDocument = false; importingData = false; }
    }
    await writeQueue;
    return isFloating && liveData ? liveData : loadState();
  });
  ipcMain.handle("data:save", async (event, value: unknown, session: unknown) => {
    assertTrusted(event);
    if (importingData || typeof session !== "string" || session !== mainDataSession)
      throw new Error("数据会话已更新，旧面板的记录未覆盖恢复的数据。");
    await saveState(value);
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
    if (keepOpen || dataDialogOpen) return;
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
    if (!leisureSuppressed && !process.argv.includes("--hidden") && !loginLaunch) showWindow();
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
  const buildMenu = () => Menu.buildFromTemplate([
    { label: "打开摸鱼时钟", click: () => showWindow() },
    { label: "偏好设置", click: () => showWindow(true) },
    { label: "老板键：收起摸鱼窗口", click: () => { void bossKey?.trigger().catch(() => {}); } },
    { label: "恢复摸鱼窗口（保持暂停）", click: () => { void bossKey?.restore().catch(() => {}); } },
    ...(process.platform === "win32" ? [{
      label: "显示悬浮窗",
      type: "checkbox" as const,
      checked: floating?.getState().enabled ?? true,
      click: () => {
        void floating?.setEnabled(!floating.getState().enabled).catch((error: Error) => {
          dialog.showErrorBox("悬浮窗设置失败", error.message);
        });
      },
    }] : []),
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
  if (process.platform === "linux") tray.setContextMenu(buildMenu());
  else tray.on("right-click", () => tray?.popUpContextMenu(buildMenu()));
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
    dataManagement?.dispose();
    bossKey?.dispose();
    youtube?.dispose();
    bilibili?.dispose();
    player?.dispose();
    holidays?.dispose();
    floating?.dispose();
    updater?.dispose();
    tray?.destroy();
    tray = null;
  });
  app
    .whenReady()
    .then(async () => {
      if (process.platform === "darwin") app.dock?.hide();
      biliHistory = await createBilibiliHistory({
        directory: app.getPath("userData"),
        onState: state => sendMain("bilibili:history-state", state),
      });
      bilibili = await createBilibiliService({ onAuth: state => broadcastMedia("bilibili:auth-state", state) });
      bilibili.registerMediaProtocol(session.defaultSession);
      player = createBilibiliWindow({
        root,
        preload: join(__dirname, "preload.cjs"),
        devServer,
        onState: state => {
          if (!state.open) playbackRequest++;
          broadcastMedia("bilibili:player-state", state);
          broadcastCurrentMedia();
        },
        onTransportState: broadcastTransport,
      });
      holidays = await createHolidayService({
        onState: (state) => {
          for (const window of [win, floating?.getWindow()]) {
            if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
              try {
                window.webContents.send("holidays:state", state);
              } catch {
                // A renderer reload obtains the current snapshot on startup.
              }
            }
          }
        },
      });
      floating = await createFloatingController({
        root,
        preload: join(__dirname, "preload.cjs"),
        devServer,
        isMainSender: trustedSender,
        showPanel: () => showWindow(),
        onState: (state) => {
          if (win && !win.isDestroyed())
            win.webContents.send("floating:state", state);
        },
      });
      youtube = await createYouTubeWindow({ extensionDirectory, onState: onYouTubeState, onTransportState: onYouTubeTransport }).catch(() => null);
      broadcastCurrentMedia();
      bossKey = await createBossKeyController({
        directory: app.getPath("userData"), shortcuts: globalShortcut,
        onTrigger: concealLeisure, onRestore: restoreLeisure,
        onRepeatTrigger: repeatConcealLeisure,
        onState: (state: BossKeyState) => broadcastMedia("boss-key:state", state),
      });
      dataManagement = await createDataManagement({
        directory: app.getPath("userData"), capture: captureDataBackup, apply: applyDataBackup,
        chooseImport: async () => {
          const options = { title: "导入摸鱼时钟备份", properties: ["openFile"] as ["openFile"], filters: [{ name: "JSON 备份", extensions: ["json"] }] };
          dataDialogOpen = true;
          try {
            const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
            return result.canceled ? null : result.filePaths[0] ?? null;
          } finally { dataDialogOpen = false; }
        },
        chooseExport: async suggestedName => {
          const options = { title: "导出摸鱼时钟备份", defaultPath: suggestedName, filters: [{ name: "JSON 备份", extensions: ["json"] }] };
          dataDialogOpen = true;
          try {
            const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
            return result.canceled ? null : result.filePath ?? null;
          } finally { dataDialogOpen = false; }
        },
        onState: state => sendMain("backup:state", state),
      });
      updater = createUpdaterController({
        onState: (state) => {
          if (state.status === "error") quitAllowed = false;
          if (win && !win.isDestroyed() && !win.webContents.isDestroyed())
            win.webContents.send("updater:state", state);
        },
        beforeInstall: async () => {
          await dataManagement?.flush();
          await writeQueue;
          await bilibili?.flush();
          await biliHistory?.flush().catch(() => {});
          await bossKey?.flush();
          await youtube?.pauseAndHide();
          await youtube?.flush();
          await holidays?.flush().catch(() => {});
          await floating?.flush();
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
      try {
        await floating.initializeWindow();
      } catch (error) {
        await floating.setEnabled(false).catch(() => {});
        dialog.showErrorBox(
          "悬浮窗暂时无法打开",
          `完整面板仍可使用，请从偏好设置重试。${error instanceof Error ? error.message : ""}`,
        );
      }
      holidays.start();
    })
    .catch((error: Error) => {
      dialog.showErrorBox("摸鱼时钟启动失败", error.message);
      quitAllowed = true;
      app.quit();
    });
}

import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createBilibiliDesktopFixture } from "./bilibili-desktop-fixture.mjs";

const { directory, userData, harnessPath, workDate } = await createBilibiliDesktopFixture({
  prefix: ".cache/data-management-ui-",
  mainSetup: `
const {dialog}=require('electron');
const {globalShortcut}=require('electron');
const {ipcMain}=require('electron');
const nativeRegister=globalShortcut.register.bind(globalShortcut);
globalShortcut.register=(shortcut,callback)=>shortcut==='Control+Alt+F12'?false:nativeRegister(shortcut,callback);
const nativeHandle=ipcMain.handle.bind(ipcMain);
globalThis.dataSessionFixture={handler:null,sessions:new Map(),oldSession:null,oldData:null};
ipcMain.handle=(channel,handler)=>{
 if(channel==='data:save'){
  globalThis.dataSessionFixture.handler=handler;
  return nativeHandle(channel,(event,data,session)=>{globalThis.dataSessionFixture.sessions.set(event.sender.id,session);return handler(event,data,session);});
 }
 return nativeHandle(channel,handler);
};
globalThis.dataDialogFixture={save:null,open:null,saves:0,opens:0,errors:[]};
dialog.showSaveDialog=async()=>{const f=globalThis.dataDialogFixture;f.saves++;return f.save?{canceled:false,filePath:f.save}:{canceled:true};};
dialog.showOpenDialog=async()=>{const f=globalThis.dataDialogFixture;f.opens++;return f.open?{canceled:false,filePaths:[f.open]}:{canceled:true,filePaths:[]};};
dialog.showErrorBox=(title,content)=>{globalThis.dataDialogFixture.errors.push({title,content});console.error('DATA_FIXTURE_NATIVE_ERROR',title,content);};
`,
});
const knownBvid = "BV17x411w7KC";
const exportPath = join(directory, "exported-backup.json");
const candidatePath = join(directory, "candidate-backup.json");
const legacyPath = join(directory, "legacy-state.json");
const conflictPath = join(directory, "conflicting-preferences.json");
const invalidPath = join(directory, "invalid-backup.json");
const secret = "fixture-private-account-value-not-real";
await writeFile(join(userData, "private-do-not-export.json"), JSON.stringify({ SESSDATA: secret, token: "fixture-git-secret-not-real" }));
await writeFile(invalidPath, "{ definitely not JSON");
const env = { ...process.env, TOUCHFISH_USER_DATA: userData, TOUCHFISH_KEEP_OPEN: "1", TOUCHFISH_HOLIDAYS_AUTO_REFRESH: "0" };
delete env.ELECTRON_RUN_AS_NODE;
let desktop, main;
const pageErrors = [], nativeErrors = [];
const management = () => main.getByRole("region", { name: "数据管理", exact: true });
const load = () => main.evaluate(() => window.touchFish.loadData());
const history = () => main.evaluate(() => window.touchFish.bilibili.getHistory());
const dialogs = (field, value) => desktop.evaluate((_electron, { field, value }) => { globalThis.dataDialogFixture[field] = value; }, { field, value });
const activeInterval = data => data.records[workDate].intervals.at(-1);
async function openSettings() {
  await main.bringToFront();
  await main.getByRole("button", { name: "设置", exact: true }).click();
  await expect(management()).toBeAttached();
  await expect(management().getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
}
async function restorePreview() {
  const reloaded = main.waitForEvent("domcontentloaded", { timeout: 15000 });
  await management().getByRole("button", { name: "确认覆盖并恢复", exact: true }).click();
  await reloaded;
  await expect(main.getByText("今日已赚", { exact: true })).toBeVisible();
  await expect(main.getByRole("heading", { name: "偏好设置", exact: true })).toHaveCount(0);
}
async function chooseFile(path) {
  await dialogs("open", path);
  await management().getByRole("button", { name: "导入备份", exact: true }).click();
}
async function exitNormally() {
  const closed = desktop.waitForEvent("close", { timeout: 15000 });
  await main.evaluate(() => window.touchFish.quit());
  await closed;
  await desktop.close().catch(() => {});
  desktop = undefined;
}

try {
  desktop = await electron.launch({ executablePath: electronPath, args: [harnessPath], env });
  desktop.process().stderr?.on("data", bytes => { if (bytes.toString().includes("DATA_FIXTURE_NATIVE_ERROR")) nativeErrors.push(bytes.toString()); });
  await expect.poll(() => desktop.windows().some(page => page.url().endsWith("/index.html"))).toBe(true);
  main = desktop.windows().find(page => page.url().endsWith("/index.html"));
  main.setDefaultTimeout(15000);
  main.on("pageerror", error => pageErrors.push(error.message));
  await expect(main.getByText("今日已赚", { exact: true })).toBeVisible();
  await main.getByRole("button", { name: /开始工作/ }).click();
  await expect(main.getByRole("button", { name: "暂停计时", exact: true })).toBeVisible();
  await main.evaluate(bvid => window.touchFish.bilibili.getVideo(bvid), knownBvid);
  // Avoid the default shortcut potentially owned by an installed personal app.
  await main.evaluate(() => window.touchFish.bossKey.setShortcut("Control+Alt+F11"));
  if (process.platform === "win32") await main.evaluate(() => window.touchFish.floating.setPrivacy(true));

  console.log("Checking unsaved settings guards, private repository configuration, and dialog cancellation...");
  await openSettings();
  const salary = main.getByRole("spinbutton", { name: "税前月薪", exact: true });
  await salary.fill("22000");
  await expect(management().getByRole("button", { name: "导出备份", exact: true })).toBeDisabled();
  await expect(management().getByRole("button", { name: "导入备份", exact: true })).toBeDisabled();
  await salary.fill("21000");
  await expect(management().getByRole("button", { name: "导出备份", exact: true })).toBeEnabled();
  await management().getByLabel("备份Git仓库链接", { exact: true }).fill("https://github.com/example/private-touchfish-data.git");
  await management().getByLabel("备份Git分支", { exact: true }).fill("main");
  await management().getByRole("button", { name: "保存仓库", exact: true }).click();
  await expect(management().getByRole("button", { name: "检查云端", exact: true })).toBeEnabled();
  await expect(management().getByRole("button", { name: "上传本机", exact: true })).toBeDisabled();
  await expect(management().getByRole("button", { name: "下载恢复", exact: true })).toBeDisabled();
  expect((await main.evaluate(() => window.touchFish.dataManagement.getState())).git.config.repository)
    .toBe("https://github.com/example/private-touchfish-data.git");
  await management().getByRole("button", { name: "导出备份", exact: true }).click();
  await expect(management()).toHaveAttribute("aria-busy", "false");
  await dialogs("open", null);
  await management().getByRole("button", { name: "导入备份", exact: true }).click();
  await expect(management().getByRole("group", { name: "导入备份预览", exact: true })).toHaveCount(0);

  console.log("Checking portable export scope while the original wage clock keeps running...");
  expect(await desktop.evaluate(({ BrowserWindow }, data) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith("/index.html"));
    const fixture = globalThis.dataSessionFixture;
    fixture.oldSession = fixture.sessions.get(window.webContents.id);
    fixture.oldData = data;
    return typeof fixture.oldSession === "string" && typeof fixture.handler === "function";
  }, await load())).toBe(true);
  await dialogs("save", exportPath);
  await management().getByRole("button", { name: "导出备份", exact: true }).click();
  await expect.poll(async () => { try { return JSON.parse(await readFile(exportPath, "utf8")).format; } catch { return null; } }).toBe("touchfish-backup");
  const exportedText = await readFile(exportPath, "utf8");
  const exported = JSON.parse(exportedText);
  expect(exported.version).toBe(1);
  expect(exported.data.settings.monthlySalary).toBe(21000);
  expect(Object.keys(exported.data.records)).toContain(workDate);
  expect(exported.history.map(entry => entry.bvid)).toContain(knownBvid);
  expect(exported.preferences.bossShortcut).toBe("Control+Alt+F11");
  expect(exportedText).not.toMatch(/fixture-private-account|fixture-git-secret|SESSDATA|private-touchfish-data\.git|videoUrl|audioUrl|touchfish-media|qrcode_key/);
  expect(activeInterval(exported.data).to).not.toBeNull();
  expect(activeInterval(await load()).to).toBeNull();
  const from = activeInterval(await load()).from;
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(activeInterval(await load())).toEqual({ from, to: null });
  await management().getByRole("heading", { name: "数据管理", exact: true }).scrollIntoViewIfNeeded();
  await main.screenshot({ path: ".cache/data-management-panel.png", scale: "css" });
  await management().getByLabel("备份Git仓库链接", { exact: true }).scrollIntoViewIfNeeded();
  await main.screenshot({ path: ".cache/data-management-git.png", scale: "css" });

  console.log("Checking invalid files, import preview, cancellation, paused restore and recovery backup...");
  await chooseFile(invalidPath);
  await expect(management().getByRole("alert")).toContainText(/JSON|格式/);
  expect((await load()).settings.monthlySalary).toBe(21000);
  expect(activeInterval(await load()).to).toBeNull();
  const candidate = structuredClone(exported);
  candidate.data.settings.monthlySalary = 33000;
  candidate.history = [];
  if (candidate.preferences.floating) candidate.preferences.floating.privacy = false;
  await writeFile(candidatePath, JSON.stringify(candidate));
  await chooseFile(candidatePath);
  const preview = management().getByRole("group", { name: "导入备份预览", exact: true });
  await expect(preview).toBeVisible();
  await expect(preview).toBeFocused();
  await expect(preview.getByRole("heading")).toBeInViewport({ ratio: 1 });
  await expect(preview.getByRole("button", { name: "确认覆盖并恢复", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(preview).toContainText("1 天");
  await expect(preview).toContainText("0 条");
  await main.screenshot({ path: ".cache/data-import-preview.png", scale: "css" });
  expect((await load()).settings.monthlySalary).toBe(21000);
  expect(activeInterval(await load()).to).toBeNull();
  await preview.getByRole("button", { name: "取消导入", exact: true }).click();
  await expect(preview).toHaveCount(0);
  expect((await load()).settings.monthlySalary).toBe(21000);
  await chooseFile(candidatePath);
  // Obstruct only the exact temporary file in this test's isolated userData.
  // A failed core write must leave the old disk data/history and recovery file
  // available; removing this newly-created empty directory permits a retry.
  const obstruction = join(userData, "state.tmp.json");
  expect(dirname(obstruction)).toBe(userData);
  await load();
  await mkdir(obstruction);
  try {
    await management().getByRole("button", { name: "确认覆盖并恢复", exact: true }).click();
    await expect(management().getByRole("alert")).toContainText(/恢复未完成/);
    await expect(preview).toBeVisible();
    expect(JSON.parse(await readFile(join(userData, "state.json"), "utf8")).settings.monthlySalary).toBe(21000);
    expect((await history()).entries.map(entry => entry.bvid)).toContain(knownBvid);
    expect(JSON.parse(await readFile(join(userData, "data-recovery.json"), "utf8")).data.settings.monthlySalary).toBe(21000);
  } finally { await rmdir(obstruction); }
  await restorePreview();
  expect((await load()).settings.monthlySalary).toBe(33000);
  // Invoke the recorded native handler with a valid current sender/frame, but
  // the original document's session and salary. Rejecting this specifically as
  // stale proves an old autosave cannot replace the restored snapshot.
  const lateSave = await desktop.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith("/index.html"));
    const fixture = globalThis.dataSessionFixture;
    try {
      await fixture.handler({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, fixture.oldData, fixture.oldSession);
      return { rejected: false, message: "" };
    } catch (error) { return { rejected: true, message: error.message }; }
  });
  expect(lateSave.rejected).toBe(true);
  expect(lateSave.message).toContain("数据会话已更新");
  expect((await load()).settings.monthlySalary).toBe(33000);
  expect(activeInterval(await load()).to).not.toBeNull();
  await expect(main.getByRole("button", { name: /继续工作/ })).toBeVisible();
  expect((await history()).entries).toEqual([]);
  if (process.platform === "win32") expect((await main.evaluate(() => window.touchFish.floating.getState())).privacy).toBe(false);
  const recovery = JSON.parse(await readFile(join(userData, "data-recovery.json"), "utf8"));
  expect(recovery.data.settings.monthlySalary).toBe(21000);
  expect(recovery.history.map(entry => entry.bvid)).toContain(knownBvid);
  expect((await main.evaluate(() => window.touchFish.dataManagement.getState())).recoveryAvailable).toBe(true);

  await openSettings();
  await management().getByRole("button", { name: "恢复导入前数据", exact: true }).click();
  await expect(management().getByRole("group", { name: "导入备份预览", exact: true })).toContainText("1 条");
  await restorePreview();
  expect((await load()).settings.monthlySalary).toBe(21000);
  expect((await history()).entries.map(entry => entry.bvid)).toContain(knownBvid);
  expect(activeInterval(await load()).to).not.toBeNull();
  if (process.platform === "win32") expect((await main.evaluate(() => window.touchFish.floating.getState())).privacy).toBe(true);

  console.log("Checking conflicting machine preferences preserve the preview for a scoped retry...");
  const conflict = structuredClone(candidate);
  conflict.data.settings.monthlySalary = 34000;
  conflict.preferences.bossShortcut = "Control+Alt+F12";
  await writeFile(conflictPath, JSON.stringify(conflict));
  await openSettings();
  await chooseFile(conflictPath);
  await management().getByRole("button", { name: "确认覆盖并恢复", exact: true }).click();
  await expect(management().getByRole("alert")).toContainText(/原有数据已保留|未完成/);
  await expect(management().getByRole("group", { name: "导入备份预览", exact: true })).toBeVisible();
  expect((await load()).settings.monthlySalary).toBe(21000);
  expect((await history()).entries.map(entry => entry.bvid)).toContain(knownBvid);
  await management().getByRole("checkbox", { name: "同时恢复悬浮窗和老板键偏好", exact: true }).uncheck();
  await restorePreview();
  expect((await load()).settings.monthlySalary).toBe(34000);
  expect((await main.evaluate(() => window.touchFish.bossKey.getState())).shortcut).toBe("Control+Alt+F11");
  if (process.platform === "win32") expect((await main.evaluate(() => window.touchFish.floating.getState())).privacy).toBe(true);
  await main.evaluate(bvid => window.touchFish.bilibili.getVideo(bvid), knownBvid);

  console.log("Checking legacy state files, optional preferences, and main-window-only backup authority...");
  const legacy = structuredClone(exported.data);
  legacy.settings.monthlySalary = 36000;
  await writeFile(legacyPath, JSON.stringify(legacy));
  await openSettings();
  await chooseFile(legacyPath);
  await expect(management().getByRole("group", { name: "导入备份预览", exact: true })).toContainText("不包含，保留本机历史");
  await restorePreview();
  expect((await load()).settings.monthlySalary).toBe(36000);
  expect((await history()).entries.map(entry => entry.bvid)).toContain(knownBvid);
  if (process.platform === "win32") expect((await main.evaluate(() => window.touchFish.floating.getState())).privacy).toBe(true);
  // Re-import a complete bundle while excluding only its machine preferences.
  await openSettings();
  await chooseFile(candidatePath);
  const preferences = management().getByRole("checkbox", { name: "同时恢复悬浮窗和老板键偏好", exact: true });
  await expect(preferences).toBeChecked();
  await preferences.uncheck();
  await restorePreview();
  expect((await load()).settings.monthlySalary).toBe(33000);
  expect((await history()).entries).toEqual([]);
  if (process.platform === "win32") expect((await main.evaluate(() => window.touchFish.floating.getState())).privacy).toBe(true);
  const dialogsBefore = await desktop.evaluate(() => ({ saves: globalThis.dataDialogFixture.saves, opens: globalThis.dataDialogFixture.opens }));
  await main.evaluate(bvid => window.touchFish.bilibili.play({ bvid, mode: "audio", cid: 101 }), knownBvid);
  await expect.poll(() => desktop.windows().some(page => page.url().includes("window=player"))).toBe(true);
  const restricted = desktop.windows().filter(page => /window=(?:floating|player)/.test(page.url()));
  expect(restricted.length).toBeGreaterThan(0);
  for (const page of restricted) {
    const denied = await page.evaluate(async () => {
      const api = window.touchFish.dataManagement;
      const calls = {
        get: () => api.getState(), export: () => api.exportBackup(), import: () => api.previewImport(),
        remote: () => api.previewRemote(), recovery: () => api.previewRecovery(),
        restore: () => api.restorePreview("fixture-invalid-preview"), cancel: () => api.cancelPreview("fixture-invalid-preview"),
        configure: () => api.configureGit(null), check: () => api.checkGit(), upload: () => api.uploadGit(),
      };
      const result = {};
      for (const [name, call] of Object.entries(calls)) { try { await call(); result[name] = false; } catch { result[name] = true; } }
      return result;
    });
    expect(Object.values(denied).every(Boolean)).toBe(true);
  }
  expect(await desktop.evaluate(() => ({ saves: globalThis.dataDialogFixture.saves, opens: globalThis.dataDialogFixture.opens }))).toEqual(dialogsBefore);
  expect(await desktop.evaluate(() => globalThis.dataDialogFixture.errors)).toEqual([]);
  expect(pageErrors).toEqual([]);
  await exitNormally();
  expect(nativeErrors).toEqual([]);

  console.log("Checking native dialog focus protection with ordinary automatic panel concealment...");
  desktop = await electron.launch({ executablePath: electronPath, args: [harnessPath], env: { ...env, TOUCHFISH_KEEP_OPEN: "0" } });
  desktop.process().stderr?.on("data", bytes => { if (bytes.toString().includes("DATA_FIXTURE_NATIVE_ERROR")) nativeErrors.push(bytes.toString()); });
  await expect.poll(() => desktop.windows().some(page => page.url().endsWith("/index.html"))).toBe(true);
  main = desktop.windows().find(page => page.url().endsWith("/index.html"));
  main.setDefaultTimeout(15000);
  main.on("pageerror", error => pageErrors.push(error.message));
  await expect(main.getByText("今日已赚", { exact: true })).toBeVisible();
  await openSettings();
  await desktop.evaluate(({ dialog }) => {
    globalThis.dataDeferredDialog = { open: false, release: null };
    dialog.showOpenDialog = () => new Promise(resolve => {
      globalThis.dataDeferredDialog.open = true;
      globalThis.dataDeferredDialog.release = () => resolve({ canceled: true, filePaths: [] });
    });
  });
  await management().getByRole("button", { name: "导入备份", exact: true }).click();
  await expect.poll(() => desktop.evaluate(() => globalThis.dataDeferredDialog.open)).toBe(true);
  expect(await desktop.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith("/index.html"));
    window.emit("blur");
    return window.isVisible();
  })).toBe(true);
  await desktop.evaluate(() => globalThis.dataDeferredDialog.release());
  await expect.poll(() => main.evaluate(() => window.touchFish.dataManagement.getState().then(state => state.busy))).toBe(false);
  await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().endsWith("/index.html"));
    window.emit("blur");
    return window.isVisible();
  })).toBe(false);
  expect(await desktop.evaluate(() => globalThis.dataDialogFixture.errors)).toEqual([]);
  expect(pageErrors).toEqual([]);
  await exitNormally();
  expect(nativeErrors).toEqual([]);
  console.log("PASS: portable backup scope, active export without pause, preview/cancel/invalid input, failed-write recovery and retry, old-document autosave rejection, paused restore, native-dialog focus protection, legacy preservation, optional preferences, unsaved draft guards, Git configuration without network, and main-window-only authority. Real private-repository authentication was not exercised.");
} finally {
  await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await desktop?.close().catch(() => {});
}

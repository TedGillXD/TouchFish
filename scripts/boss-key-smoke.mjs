import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createBilibiliDesktopFixture } from "./bilibili-desktop-fixture.mjs";

// The fixture keeps real native playback, global shortcut registration and
// persistent state isolated from the user's own running application.
const { directory, userData, harnessPath } = await createBilibiliDesktopFixture({
  prefix: ".cache/boss-key-ui-",
  mainSetup: `
const {globalShortcut,ipcMain}=require('electron');
const {writeFileSync}=require('node:fs');
const shortcutLog=[];
const registerShortcut=globalShortcut.register.bind(globalShortcut);
const unregisterShortcut=globalShortcut.unregister.bind(globalShortcut);
const shortcuts=new Map();
const logPath=process.env.TOUCHFISH_SHORTCUT_LOG;
const log=entry=>{shortcutLog.push(entry);writeFileSync(logPath,JSON.stringify(shortcutLog));};
globalShortcut.register=(shortcut,callback)=>{
 const result=shortcut==='CommandOrControl+Alt+Y'?false:registerShortcut(shortcut,callback);
 if(result)shortcuts.set(shortcut,callback);
 log({operation:'register',shortcut,result});return result;
};
globalShortcut.unregister=shortcut=>{shortcuts.delete(shortcut);log({operation:'unregister',shortcut});return unregisterShortcut(shortcut);};
globalThis.bossShortcutProbe={invoke:shortcut=>{const callback=shortcuts.get(shortcut);if(!callback)throw new Error('Shortcut is not registered');callback();},registered:shortcut=>globalShortcut.isRegistered(shortcut)};
const nativeOn=ipcMain.on.bind(ipcMain);let holdReports=false;const reports=[];
ipcMain.on=(channel,listener)=>nativeOn(channel,channel==='bilibili:transport-report'?(...args)=>{if(holdReports)reports.push({listener,args});else listener(...args);}:listener);
globalThis.bossTransportProbe={hold:()=>{holdReports=true;},release:()=>{holdReports=false;for(const item of reports.splice(0))item.listener(...item.args);},get pending(){return reports.length;}};
`,
});
const shortcutLog = join(directory, "shortcuts.json");
const env = { ...process.env, TOUCHFISH_USER_DATA: userData,
  TOUCHFISH_SHORTCUT_LOG: shortcutLog, TOUCHFISH_KEEP_OPEN: "1", TOUCHFISH_HOLIDAYS_AUTO_REFRESH: "0" };
delete env.ELECTRON_RUN_AS_NODE;
let desktop, main, player, floating;
const errors = [];
const readData = async () => JSON.parse(await readFile(join(userData, "state.json"), "utf8"));
const seconds = text => text.split(":").reduce((sum, value) => sum * 60 + Number(value), 0);

async function bounded(label, callback, timeout = 20000) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(callback), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout);
  })]); } finally { clearTimeout(timer); }
}
const boss = () => main.evaluate(() => window.touchFish.bossKey.getState());
const fixture = (operation, value) => desktop.evaluate((_electron, { operation, value }) => globalThis.biliFixture[operation](value), { operation, value });
const media = () => player.evaluate(() => [...document.querySelectorAll("video,audio")].map(element => ({
  tag: element.tagName, time: element.currentTime, paused: element.paused, ready: element.readyState, source: element.getAttribute("src"),
})));
const windows = () => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
  url: window.webContents.getURL(), visible: window.isVisible(), minimized: window.isMinimized(),
})));
async function allSheltered() {
  await expect.poll(async () => (await windows()).every(window => !window.visible || window.minimized)).toBe(true);
}
async function paused() {
  await expect.poll(async () => { const tracks = await media(); return tracks.length === 2 && tracks.every(track => track.paused); }).toBe(true);
  const before = await media();
  await new Promise(resolve => setTimeout(resolve, 300));
  const after = await media();
  for (let index = 0; index < after.length; index++) expect(Math.abs(after[index].time - before[index].time)).toBeLessThan(0.04);
}
async function playing() {
  await expect.poll(async () => { const tracks = (await media()).filter(track => track.source); return tracks.length === 2 && tracks.every(track => track.ready >= 2 && !track.paused); }).toBe(true);
}
async function stop() {
  if (!desktop) return;
  const child = desktop.process(), current = desktop;
  desktop = undefined;
  await bounded("exit isolated app", () => current.evaluate(({ app }) => app.exit(0)), 5000)
    .catch(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await bounded("close isolated connection", () => current.close(), 5000)
    .catch(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
}

try {
  desktop = await electron.launch({ executablePath: electronPath, args: [harnessPath], env });
  await expect.poll(() => desktop.windows().some(page => page.url().endsWith("/index.html"))).toBe(true);
  main = desktop.windows().find(page => page.url().endsWith("/index.html"));
  main.setDefaultTimeout(15000);
  main.on("pageerror", error => errors.push(error.message));
  await expect(main.getByText("今日已赚", { exact: true })).toBeVisible();
  if (process.platform === "win32") {
    await expect.poll(() => desktop.windows().some(page => page.url().includes("window=floating"))).toBe(true);
    floating = desktop.windows().find(page => page.url().includes("window=floating"));
    floating.setDefaultTimeout(15000);
    floating.on("pageerror", error => errors.push(error.message));
  }
  await main.getByRole("button", { name: /开始工作/ }).click();
  await expect(main.getByRole("button", { name: "暂停计时", exact: true })).toBeVisible();

  console.log("Checking actual shortcut registration and conflict-safe configuration...");
  const initial = await boss();
  expect(initial.shortcut).toBe("CommandOrControl+Alt+B");
  expect(initial.registered).toBe(true);
  expect(await desktop.evaluate((_electron, shortcut) => globalThis.bossShortcutProbe.registered(shortcut), initial.shortcut)).toBe(true);
  const conflict = await main.evaluate(async () => {
    try { await window.touchFish.bossKey.setShortcut("CommandOrControl+Alt+Y"); return false; } catch { return true; }
  });
  expect(conflict).toBe(true);
  expect((await boss()).shortcut).toBe(initial.shortcut);
  expect((await boss()).registered).toBe(true);
  expect(await desktop.evaluate((_electron, shortcut) => globalThis.bossShortcutProbe.registered(shortcut), initial.shortcut)).toBe(true);
  expect(await main.evaluate(async () => {
    try { await window.touchFish.bossKey.setShortcut("B"); return false; } catch { return true; }
  })).toBe(true);
  let configured = await main.evaluate(() => window.touchFish.bossKey.setShortcut("CommandOrControl+Alt+N"));
  expect(configured.registered).toBe(true);
  expect(configured.shortcut).toBe("CommandOrControl+Alt+N");
  expect(await desktop.evaluate((_electron, shortcut) => globalThis.bossShortcutProbe.registered(shortcut), initial.shortcut)).toBe(false);

  console.log("Checking real two-track playback, one-way shelter and independent wage accrual...");
  await main.evaluate(() => window.touchFish.bilibili.play({ bvid: "BV17x411w7KC", mode: "video" }));
  await expect.poll(() => desktop.windows().some(page => page.url().includes("window=player"))).toBe(true);
  player = desktop.windows().find(page => page.url().includes("window=player"));
  player.setDefaultTimeout(15000);
  player.on("pageerror", error => errors.push(error.message));
  await playing();
  await expect.poll(async () => (await media())[0].time).toBeGreaterThan(0.4);
  const wageBefore = seconds(await main.locator(".mono").innerText());
  const sourceBefore = (await media()).map(track => track.source);
  await desktop.evaluate(() => globalThis.bossTransportProbe.hold());
  await desktop.evaluate((_electron, shortcut) => globalThis.bossShortcutProbe.invoke(shortcut), configured.shortcut);
  await expect.poll(async () => { const state = await boss(); return state.hidden && state.busy; }).toBe(true);
  await expect.poll(() => desktop.evaluate(() => globalThis.bossTransportProbe.pending)).toBeGreaterThan(0);
  // A tray click can reopen the panel before the media pause acknowledgment.
  // A second real registered callback must hide it synchronously again.
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith("/index.html")).show());
  expect(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith("/index.html")).isVisible())).toBe(true);
  await desktop.evaluate((_electron, shortcut) => globalThis.bossShortcutProbe.invoke(shortcut), configured.shortcut);
  expect(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().endsWith("/index.html")).isVisible())).toBe(false);
  await desktop.evaluate(() => globalThis.bossTransportProbe.release());
  await expect.poll(async () => { const state = await boss(); return state.hidden && !state.busy; }).toBe(true);
  await allSheltered();
  await paused();
  await expect.poll(async () => seconds(await main.locator(".mono").innerText())).toBeGreaterThan(wageBefore);
  const data = await readData(), record = Object.values(data.records).at(-1);
  expect(record.completed).toBe(false);
  expect(record.intervals.some(interval => interval.to === null)).toBe(true);
  expect((await media()).map(track => track.source)).toEqual(sourceBefore);
  await main.evaluate(() => window.touchFish.bossKey.trigger());
  await allSheltered();
  await paused();

  console.log("Checking restore stays paused and late source completion cannot reopen the app...");
  await main.evaluate(() => window.touchFish.bossKey.restore());
  expect((await boss()).hidden).toBe(false);
  await expect.poll(async () => (await windows()).some(window => window.url.includes("window=player") && window.visible && !window.minimized)).toBe(true);
  await paused();
  const state = await main.evaluate(() => window.touchFish.bilibili.getTransportState());
  expect(state.playIntent).toBe(false);
  await main.evaluate(state => window.touchFish.bilibili.setPlaying(true, state.revision), state);
  await playing();
  await fixture("setPlayDelay", true);
  const pending = main.evaluate(() => window.touchFish.bilibili.play({ bvid: "BV17x411w7KC", mode: "video", quality: 16 }))
    .then(() => "resolved", () => "cancelled");
  await expect.poll(() => desktop.evaluate(() => globalThis.biliFixture.playPending)).toBeGreaterThan(0);
  await main.evaluate(() => window.touchFish.bossKey.trigger());
  await fixture("releasePlay");
  await bounded("late playback request", () => pending);
  await allSheltered();
  await paused();
  expect((await boss()).hidden).toBe(true);

  console.log("Checking shortcut settings remain main-window-only and quit unregisters the owned shortcut...");
  for (const page of [player, floating].filter(Boolean)) {
    expect(await page.evaluate(async () => {
      try { await window.touchFish.bossKey.setShortcut("CommandOrControl+Alt+M"); return false; } catch { return true; }
    })).toBe(true);
  }
  await main.evaluate(() => window.touchFish.bossKey.restore());
  await main.getByRole("button", { name: "设置", exact: true }).click();
  const preferences = main.getByRole("region", { name: "老板键设置", exact: true });
  await preferences.scrollIntoViewIfNeeded();
  const input = main.getByLabel("老板键快捷键", { exact: true });
  await input.click();
  await input.press("Control+Alt+M");
  await expect(input).toHaveValue(process.platform === "darwin" ? "Ctrl + ⌥ + M" : "Ctrl + Alt + M");
  await preferences.getByRole("button", { name: "保存快捷键", exact: true }).click();
  await expect.poll(async () => (await boss()).shortcut).toBe("Control+Alt+M");
  await expect(preferences.getByText("快捷键已注册", { exact: true })).toBeVisible();
  configured = await boss();
  expect(errors).toEqual([]);
  const closed = desktop.waitForEvent("close", { timeout: 15000 });
  await main.evaluate(() => window.touchFish.quit());
  await closed;
  await desktop.close().catch(() => {});
  desktop = undefined;
  const log = JSON.parse(await readFile(shortcutLog, "utf8"));
  expect(log.some(entry => entry.operation === "unregister" && entry.shortcut === configured.shortcut)).toBe(true);
  console.log("PASS: global callback, conflict-safe shortcut, real media pause, all app windows sheltered, wage clock continues, restore stays paused, repeated hide, late source cancellation, narrow permissions and shortcut cleanup.");
} catch (error) {
  console.error(error);
  throw error;
} finally { await stop(); }

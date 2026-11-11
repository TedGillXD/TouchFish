import { seedHolidayCache } from "./test-holiday-cache.mjs";
import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, rmdir } from "node:fs/promises";
import { resolve } from "node:path";

if (process.platform !== "win32") {
  console.log("SKIP: the floating window is available on Windows only.");
  process.exit(0);
}

// Use an actual Electron process and isolated files; never touch the user's data.
await mkdir(".cache", { recursive: true });
const userData = await mkdtemp(resolve(".cache/floating-smoke-"));
await seedHolidayCache(userData);
const env = {
  ...process.env,
  TOUCHFISH_USER_DATA: userData,
  TOUCHFISH_KEEP_OPEN: "1",
  TOUCHFISH_HOLIDAYS_AUTO_REFRESH: "0",
};
delete env.ELECTRON_RUN_AS_NODE;
let app;
let main;
let floating;
const errors = [];
const readPreferences = async () =>
  JSON.parse(await readFile(resolve(userData, "floating.json"), "utf8"));
const readData = async () =>
  JSON.parse(await readFile(resolve(userData, "state.json"), "utf8"));

async function launch() {
  app = await electron.launch({
    executablePath: process.env.TOUCHFISH_EXECUTABLE || electronPath,
    args: process.env.TOUCHFISH_EXECUTABLE ? [] : ["."],
    env,
  });
  await expect.poll(() => app.windows().filter((page) =>
    page.url().includes("window=floating")).length).toBe(1);
  main = app.windows().find((page) => !page.url().includes("window=floating"));
  floating = app.windows().find((page) => page.url().includes("window=floating"));
  expect(main).toBeTruthy();
  expect(floating).toBeTruthy();
  for (const page of [main, floating]) {
    page.setDefaultTimeout(15000);
    page.on("pageerror", (error) => errors.push(error.message));
  }
  await expect(main.getByText("今日已赚", { exact: true })).toBeVisible();
  await expect(floating.locator(".floating-card")).toBeVisible();
}

async function windowInfo(floatingWindow = true) {
  return app.evaluate(({ BrowserWindow }, isFloating) => {
    const win = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes("window=floating") === isFloating,
    );
    return {
      bounds: win.getBounds(),
      visible: win.isVisible(),
      onTop: win.isAlwaysOnTop(),
      resizable: win.isResizable(),
    };
  }, floatingWindow);
}

async function assertSize(width, height) {
  await expect.poll(async () => (await windowInfo()).bounds.width).toBe(width);
  expect((await windowInfo()).bounds.height).toBe(height);
  expect(await floating.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth > innerWidth,
    vertical: document.documentElement.scrollHeight > innerHeight,
  }))).toEqual({ horizontal: false, vertical: false });
}

async function tick(milliseconds) {
  // Playwright's clock belongs to the BrowserContext shared by both windows.
  await main.clock.runFor(milliseconds);
}

async function jumpTo(isoDate) {
  const target = new Date(isoDate).getTime();
  const delta = target - await main.evaluate(() => Date.now());
  if (delta < 0) throw new Error("Test clocks must advance together.");
  await main.clock.fastForward(delta);
}

async function assertMirroredTime(expected) {
  await expect(main.locator(".mono")).toHaveText(expected);
  await expect(floating.locator(".floating-duration")).toHaveText(expected);
  const amount = (text) => text.replace(/[^\d.,]/g, "");
  await expect.poll(async () => amount(await floating.locator(".floating-earnings").innerText()))
    .toBe(amount(await main.locator(".earnings > span").nth(1).innerText()));
  const percent = await main.getByRole("progressbar", { name: "今日上班进度" })
    .getAttribute("aria-valuenow");
  await expect(floating.locator(".floating-percent")).toHaveText(`${Number(percent).toFixed(1)}%`);
}

async function quitNormally() {
  const closed = app.waitForEvent("close", { timeout: 15000 });
  await main.evaluate(() => window.touchFish.quit());
  await closed;
  app = undefined;
}

try {
  await launch();
  await assertSize(164, 44);
  expect((await windowInfo()).onTop).toBe(true);
  expect((await windowInfo()).resizable).toBe(false);
  await main.clock.install({ time: new Date("2026-11-10T17:58:00") });
  await main.clock.pauseAt(new Date("2026-11-10T17:59:00"));
  await floating.getByRole("button", { name: "展开悬浮窗" }).click();
  await assertSize(264, 148);
  await expect(floating.locator(".floating-status")).toHaveText("未开始");

  console.log("Checking live read-only wage mirroring and meal boundaries...");
  await main.getByRole("button", { name: "设置", exact: true }).click();
  await main.getByRole("spinbutton", { name: "税前月薪" }).fill("22000");
  await main.getByLabel("周二下班时间").fill("21:00");
  await main.getByRole("button", { name: "保存设置" }).click();
  await expect.poll(async () => (await readData()).settings.monthlySalary).toBe(22000);
  await main.getByRole("button", { name: /开始工作/ }).click();
  await expect(floating.locator(".floating-status")).toHaveText("计时中");
  await tick(30000);
  await assertMirroredTime("00:00:30");
  await main.getByRole("button", { name: "暂停计时" }).click();
  await expect(floating.locator(".floating-status")).toHaveText("已暂停");
  await tick(15000);
  await assertMirroredTime("00:00:30");
  await main.getByRole("button", { name: /继续工作/ }).click();
  await tick(16000);
  await expect(floating.locator(".floating-status")).toHaveText("晚饭中");
  await assertMirroredTime("00:00:45");
  await jumpTo("2026-11-10T18:30:00");
  await assertMirroredTime("00:00:45");
  await jumpTo("2026-11-10T19:00:05");
  await expect(floating.locator(".floating-status")).toHaveText("计时中");
  await assertMirroredTime("00:00:50");
  await floating.screenshot({ path: ".cache/floating-expanded.png", scale: "css" });

  console.log("Checking live synchronization when saving to disk fails...");
  // Await earlier writes, then obstruct only this test's temporary save path.
  await main.evaluate(() => window.touchFish.loadData());
  const obstructedPath = resolve(userData, "state.tmp.json");
  await mkdir(obstructedPath);
  try {
    await main.getByRole("button", { name: "暂停计时" }).click();
    await expect(main.locator(".error-banner")).toContainText("保存失败");
    await expect(floating.locator(".floating-status")).toHaveText("已暂停");
    await tick(15000);
    await assertMirroredTime("00:00:50");
    await floating.reload();
    await expect(floating.locator(".floating-status")).toHaveText("已暂停");
    await expect(floating.locator(".floating-duration")).toHaveText("00:00:50");
    await expect(main.locator(".error-banner")).toContainText("保存失败");
  } finally {
    // This is an empty directory created above, inside the isolated test data.
    await rmdir(obstructedPath);
  }
  await main.getByRole("button", { name: /继续工作/ }).click();
  await expect(floating.locator(".floating-status")).toHaveText("计时中");
  await expect(main.locator(".error-banner")).toHaveCount(0);
  await expect.poll(async () => {
    const intervals = (await readData()).records["2026-11-10"].intervals;
    return intervals.slice(-2);
  }).toEqual([
    { from: new Date("2026-11-10T17:59:45").getTime(), to: new Date("2026-11-10T19:00:05").getTime() },
    { from: new Date("2026-11-10T19:00:20").getTime(), to: null },
  ]);

  console.log("Checking privacy, independent settings and panel switching...");
  await main.getByRole("button", { name: "隐藏金额" }).click();
  await expect(main.locator(".earnings")).toContainText("••••");
  await expect(floating.locator(".floating-earnings")).toContainText("••••");
  await expect.poll(async () => (await readPreferences()).privacy).toBe(true);
  await main.getByRole("button", { name: "收起到托盘" }).click();
  await expect.poll(async () => (await windowInfo(false)).visible).toBe(false);
  expect((await windowInfo()).visible).toBe(true);
  await floating.getByRole("button", { name: "打开完整面板" }).first().click();
  await expect.poll(async () => (await windowInfo(false)).visible).toBe(true);
  await main.getByRole("button", { name: "设置", exact: true }).click();
  const salary = main.getByRole("spinbutton", { name: "税前月薪" });
  await salary.fill("23000");
  await main.getByRole("button", { name: "收起到托盘" }).click();
  await expect.poll(async () => (await windowInfo(false)).visible).toBe(false);
  await floating.getByRole("button", { name: "打开完整面板" }).first().click();
  await expect.poll(async () => (await windowInfo(false)).visible).toBe(true);
  await expect(main.getByRole("heading", { name: "偏好设置" })).toBeVisible();
  await expect(salary).toHaveValue("23000");
  await expect.poll(async () => (await readData()).settings.monthlySalary).toBe(22000);
  const visibility = main.getByRole("switch", { name: "显示 Windows 悬浮窗" });
  await visibility.click();
  await expect.poll(async () => (await windowInfo()).visible).toBe(false);
  await expect(salary).toHaveValue("23000");
  await visibility.click();
  await expect.poll(async () => (await windowInfo()).visible).toBe(true);
  await expect(salary).toHaveValue("23000");
  await expect.poll(async () => (await readData()).settings.monthlySalary).toBe(22000);
  await main.getByRole("button", { name: "返回", exact: true }).click();

  // The shared preload does not grant a floating renderer write/update authority.
  expect(await floating.evaluate(async () => {
    const denied = async (callback) => {
      try { await callback(); return false; } catch { return true; }
    };
    const data = await window.touchFish.loadData();
    return {
      save: await denied(() => window.touchFish.saveData(data)),
      update: await denied(() => window.touchFish.updater.check()),
    };
  })).toEqual({ save: true, update: true });

  console.log("Checking native position persistence, resizing and close/reopen...");
  const expectedPosition = await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes("window=floating"));
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    const position = { x: area.x + 80, y: area.y + 80 };
    win.setPosition(position.x, position.y);
    return position;
  });
  await expect.poll(async () => (await readPreferences()).position).toEqual(expectedPosition);
  await floating.getByRole("button", { name: "收起悬浮窗" }).click();
  await assertSize(164, 44);
  expect((await windowInfo()).bounds).toMatchObject(expectedPosition);
  await floating.screenshot({ path: ".cache/floating-compact.png", scale: "css" });
  await floating.getByRole("button", { name: "展开悬浮窗" }).click();
  await assertSize(264, 148);
  expect((await windowInfo()).bounds).toMatchObject(expectedPosition);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes("window=floating")).close();
  });
  await expect.poll(async () => (await windowInfo()).visible).toBe(false);
  await expect.poll(async () => (await readPreferences()).enabled).toBe(false);
  await main.evaluate(() => window.touchFish.floating.setEnabled(true));
  await expect.poll(async () => (await windowInfo()).visible).toBe(true);

  await jumpTo("2026-11-10T21:00:01");
  await expect(floating.locator(".floating-status")).toHaveText("已下班");
  await expect.poll(async () => (await readData()).records["2026-11-10"].completed).toBe(true);
  console.log("Checking the next day, scheduled start and lunch...");
  await jumpTo("2026-11-11T08:30:00");
  await expect(floating.locator(".floating-status")).toHaveText("未开始");
  await main.getByRole("button", { name: /开始工作/ }).click();
  await expect(floating.locator(".floating-status")).toHaveText("等待上班");
  await expect(floating.locator(".floating-duration")).toHaveText("00:00:00");
  await jumpTo("2026-11-11T12:00:00");
  await expect(floating.locator(".floating-status")).toHaveText("午休中");
  await expect(floating.locator(".floating-duration")).toHaveText("03:00:00");
  await jumpTo("2026-11-11T12:30:00");
  await expect(floating.locator(".floating-duration")).toHaveText("03:00:00");
  await jumpTo("2026-11-11T13:00:05");
  await expect(floating.locator(".floating-status")).toHaveText("计时中");
  await expect(floating.locator(".floating-duration")).toHaveText("03:00:05");
  await jumpTo("2026-11-11T18:00:01");
  await expect(floating.locator(".floating-status")).toHaveText("已下班");
  await expect.poll(async () => (await readData()).records["2026-11-11"].completed).toBe(true);
  await quitNormally();
  await launch();
  await assertSize(264, 148);
  expect((await windowInfo()).bounds).toMatchObject(expectedPosition);
  await expect(main.locator(".earnings")).toContainText("••••");
  await expect(floating.locator(".floating-earnings")).toContainText("••••");

  // A previously visible position must remain reachable after a monitor change.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes("window=floating")).setPosition(-30000, -30000);
  });
  await expect.poll(async () => app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes("window=floating"));
    const bounds = win.getBounds();
    return screen.getAllDisplays().some(({ workArea: area }) =>
      bounds.x >= area.x && bounds.y >= area.y &&
      bounds.x + bounds.width <= area.x + area.width &&
      bounds.y + bounds.height <= area.y + area.height);
  })).toBe(true);
  expect(errors).toEqual([]);
  await quitNormally();
  console.log("PASS: floating wages/meal/pause/end synchronization, disk-failure live state and recovery, privacy persistence, read-only IPC, independent preferences and unsaved drafts, hide/reopen, native position persistence, expansion bounds and offscreen recovery.");
  console.log(`Isolated data: ${userData}`);
} finally {
  await app?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
}

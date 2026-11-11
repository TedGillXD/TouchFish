import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

if (process.platform !== "win32") {
  console.log("SKIP: this desktop holiday flow also exercises the Windows floating window.");
  process.exit(0);
}

// This launches the real compiled app. Only this test's isolated holiday Session
// has an HTTPS protocol fixture; OS proxy, TLS verification and production URLs
// remain untouched. Test dates live outside the application bundle.
await mkdir(".cache", { recursive: true });
const directory = await mkdtemp(resolve(".cache/holiday-ui-"));
const userData = join(directory, "user-data");
const fixturePath = resolve("tests/fixtures/china-holidays.json");
const harnessPath = join(directory, "holiday-ui-harness.cjs");
const mainPath = resolve("dist-electron/main.cjs");
await writeFile(harnessPath, `
const { app, session } = require('electron');
const { readFileSync } = require('node:fs');
app.setPath('userData', process.env.TOUCHFISH_USER_DATA);
const fixtures = JSON.parse(readFileSync(${JSON.stringify(fixturePath)}, 'utf8'));
let mode = 'offline';
const requests = [];
globalThis.holidayUiFixture = { setMode: value => { mode = value; }, requests };
app.whenReady().then(async () => {
  const network = session.fromPartition('touchfish-holidays', { cache: false });
  network.protocol.handle('https', request => {
    const url = new URL(request.url);
    requests.push({ host: url.hostname, path: url.pathname, mode });
    if (!['raw.githubusercontent.com', 'cdn.jsdelivr.net'].includes(url.hostname))
      return new Response('', { status: 403 });
    if (mode === 'offline') return new Response('', { status: 503 });
    const year = Number(url.pathname.split('/').at(-1)?.replace('.json', ''));
    let data = structuredClone(fixtures.find(value => value.year === year));
    if (year === 2025) data = {
      year, papers: ['https://www.gov.cn/zhengce/content/202411/content_6986383.htm'],
      days: [{ date: '2025-01-01', name: '元旦', isOffDay: true }]
    };
    if (!data) return new Response('', { status: 404 });
    if (year === 2026 && mode === 'wrong-year') data.year = 2025;
    if (year === 2026 && mode === 'corrupt') return new Response('{broken JSON', { status: 200 });
    if (year === 2026 && mode === 'today-rest')
      data.days.push({ date: '2026-10-09', name: '测试临时放假', isOffDay: true });
    if (year === 2026 && mode === 'extra-rest')
      data.days.push({ date: '2026-10-12', name: '测试新增放假', isOffDay: true });
    return new Response(JSON.stringify(data), { status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  });
  require(${JSON.stringify(mainPath)});
}).catch(error => { console.error(error); app.exit(1); });
`, "utf8");
execFileSync(process.execPath, ["--check", harnessPath], { windowsHide: true });

const env = {
  ...process.env,
  TOUCHFISH_USER_DATA: userData,
  TOUCHFISH_KEEP_OPEN: "1",
  TOUCHFISH_HOLIDAYS_AUTO_REFRESH: "0",
};
delete env.ELECTRON_RUN_AS_NODE;
let desktop;
let main;
let floating;
const errors = [];
const readData = async () => JSON.parse(await readFile(join(userData, "state.json"), "utf8"));
const readCache = async () => JSON.parse(await readFile(join(userData, "holiday-cache.json"), "utf8"));
const mode = async (value) => desktop.evaluate((_electron, next) => globalThis.holidayUiFixture.setMode(next), value);
const holidayState = () => main.evaluate(() => window.touchFish.holidays.getState());
const refresh = (years = [2026, 2027]) => main.evaluate((requested) =>
  window.touchFish.holidays.refresh(requested, true), years);
const workdays = () => main.locator(".stat-card").first().locator("strong");

async function launch() {
  desktop = await electron.launch({ executablePath: electronPath, args: [harnessPath], env });
  await expect.poll(() => desktop.windows().filter(page => page.url().includes("window=floating")).length, { timeout: 15000 }).toBe(1);
  main = desktop.windows().find(page => !page.url().includes("window=floating"));
  floating = desktop.windows().find(page => page.url().includes("window=floating"));
  for (const page of [main, floating]) {
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => errors.push(error.message));
  }
  await expect(main.getByText("今日已赚", { exact: true })).toBeVisible();
  // Electron renderer pages share a BrowserContext clock, so manipulate it once.
  await main.clock.install({ time: new Date("2026-10-09T10:00:00") });
  await main.clock.pauseAt(new Date("2026-10-09T10:00:01"));
  if (await floating.getByRole("button", { name: "展开悬浮窗" }).count())
    await floating.getByRole("button", { name: "展开悬浮窗" }).click();
  await expect(floating.locator(".floating-status")).toBeVisible();
}

async function quitNormally() {
  const closed = desktop.waitForEvent("close", { timeout: 15000 });
  await main.evaluate(() => window.touchFish.quit());
  await closed;
  desktop = undefined;
}

try {
  await launch();
  console.log("Checking a fresh app without any embedded holiday dates...");
  await refresh();
  expect((await holidayState()).years).toEqual([]);
  await expect(main.locator(".holiday-estimate-hint")).toContainText("暂为估算");
  await expect(workdays()).toContainText("22");
  await main.getByRole("button", { name: "设置", exact: true }).click();
  await expect(main.locator(".holiday-cache-years")).toContainText("尚无节假日缓存");
  await main.getByRole("spinbutton", { name: "税前月薪" }).fill("22000");
  await main.getByLabel("每月发薪日").selectOption("10");
  await main.getByRole("button", { name: "保存设置" }).click();
  await expect.poll(async () => (await readData()).settings.monthlySalary).toBe(22000);
  await expect(main.locator(".payday-shortcut")).toContainText("10月9日");

  console.log("Checking a manual download, open settings draft and automatic payroll recalculation...");
  await main.getByRole("button", { name: "设置", exact: true }).click();
  const salary = main.getByRole("spinbutton", { name: "税前月薪" });
  await salary.fill("23000");
  await mode("good");
  await main.getByRole("button", { name: "更新节假日", exact: true }).click();
  await expect(main.locator(".holiday-cache-years")).toContainText("2026、2027");
  await expect(main.getByRole("button", { name: "更新节假日", exact: true })).toBeEnabled();
  await expect(salary).toHaveValue("23000");
  expect((await readData()).settings.monthlySalary).toBe(22000);
  await main.clock.runFor(3000);
  await expect(main.locator(".toast")).toHaveCount(0);
  await main.locator(".holiday-download").scrollIntoViewIfNeeded();
  await main.screenshot({ path: "docs/holiday-sync.png", scale: "css" });
  await main.getByRole("button", { name: "返回", exact: true }).click();
  await expect(workdays()).toContainText("18");
  await expect(main.locator(".payday-shortcut")).toContainText("10月10日");
  await expect(main.locator(".holiday-estimate-hint")).toHaveCount(0);
  await main.getByRole("button", { name: "工作日历", exact: true }).click();
  await expect(main.getByRole("button", { name: "2026-10-01 休息日", exact: true })).toContainText("假");
  await expect(main.getByRole("button", { name: "2026-10-10 工作日", exact: true })).toContainText("班");
  await main.getByRole("button", { name: "返回", exact: true }).click();

  console.log("Checking shared same-day state changes in the dashboard and floating window...");
  await mode("today-rest");
  await refresh();
  await expect(main.locator(".card-heading .status")).toHaveText("休息日");
  await expect(floating.locator(".floating-status")).toHaveText("休息日");
  await mode("good");
  await refresh();
  await expect(main.getByRole("button", { name: /开始工作/ })).toBeVisible();
  await expect(floating.locator(".floating-status")).toHaveText("未开始");

  console.log("Checking manual overrides and immutable started-day wage plans...");
  await main.getByRole("button", { name: "工作日历", exact: true }).click();
  await main.getByRole("button", { name: "2026-10-01 休息日", exact: true }).click();
  await main.getByRole("button", { name: "设为工作", exact: true }).click();
  await main.getByRole("button", { name: "返回", exact: true }).click();
  await expect(workdays()).toContainText("19");
  await main.getByRole("button", { name: /开始工作/ }).click();
  await expect(floating.locator(".floating-status")).toHaveText("计时中");
  await expect.poll(async () => (await readData()).records["2026-10-09"]?.plan.workdays).toBe(19);
  const lockedPlan = (await readData()).records["2026-10-09"].plan;
  await main.clock.runFor(15000);
  await expect(main.locator(".mono")).toHaveText("00:00:15");
  const earningsBefore = await main.locator(".earnings > span").nth(1).innerText();
  await mode("extra-rest");
  await refresh();
  await expect(workdays()).toContainText("18");
  expect((await readData()).settings.overrides["2026-10-01"]).toBe("work");
  expect((await readData()).records["2026-10-09"].plan).toEqual(lockedPlan);
  await expect(main.locator(".earnings > span").nth(1)).toHaveText(earningsBefore);
  await expect(floating.locator(".floating-duration")).toHaveText("00:00:15");
  const goodDays = (await holidayState()).years.find(year => year.year === 2026).days;

  console.log("Checking invalid responses and offline errors preserve validated calendars...");
  for (const responseMode of ["wrong-year", "corrupt", "offline"]) {
    await mode(responseMode);
    const result = await refresh([2026]);
    expect(result.status).toBe("error");
    expect(result.years.find(year => year.year === 2026).days).toEqual(goodDays);
    expect((await readCache()).years.find(year => year.year === 2026).days).toEqual(goodDays);
    await expect(workdays()).toContainText("18");
    await expect(floating.locator(".floating-status")).toHaveText("计时中");
  }
  const intercepted = await desktop.evaluate(() => globalThis.holidayUiFixture.requests);
  expect(intercepted.some(request => request.host === "raw.githubusercontent.com")).toBe(true);
  expect(intercepted.some(request => request.host === "cdn.jsdelivr.net")).toBe(true);
  await quitNormally();

  console.log("Checking offline restart uses the last downloaded cache...");
  await launch();
  expect((await holidayState()).years.find(year => year.year === 2026).days).toEqual(goodDays);
  await expect(workdays()).toContainText("18");
  await expect(main.locator(".holiday-estimate-hint")).toHaveCount(0);
  expect((await readData()).settings.overrides["2026-10-01"]).toBe("work");
  expect((await readData()).records["2026-10-09"].plan).toEqual(lockedPlan);
  await refresh();
  expect((await holidayState()).years.find(year => year.year === 2026).days).toEqual(goodDays);
  expect(errors).toEqual([]);
  await quitNormally();
  console.log("PASS: empty-calendar estimate, manual online retrieval, cross-window updates, reactive workdays/payday, settings drafts, manual overrides, immutable wage plans, invalid-response rejection and offline restart cache.");
  console.log(`Isolated data: ${userData}`);
} finally {
  await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await desktop?.close().catch(() => {});
}

import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { seedHolidayCache } from "./test-holiday-cache.mjs";

// Exercise the compiled application with isolated files and a test-only HTTPS
// protocol handler. No real network, system proxy or TLS settings are changed.
await mkdir(".cache", { recursive: true });
const directory = await mkdtemp(resolve(".cache/payday-rest-"));
const harnessPath = join(directory, "payday-rest-harness.cjs");
const mainPath = resolve("dist-electron/main.cjs");
await writeFile(harnessPath, `
const { app, session } = require('electron');
app.setPath('userData', process.env.TOUCHFISH_USER_DATA);
app.whenReady().then(() => {
  session.fromPartition('touchfish-holidays', { cache: false }).protocol.handle('https', () =>
    new Response('', { status: 503 }));
  require(${JSON.stringify(mainPath)});
}).catch(error => { console.error(error); app.exit(1); });
`, "utf8");

let desktop;
let main;
let userData;
const errors = [];
const readData = async () => JSON.parse(await readFile(join(userData, "state.json"), "utf8"));
const restBadge = day => main.locator(`.time-row[data-weekday="${day}"] .rest-day-badge`);
const publicHolidaySwitch = () => main.getByRole("switch", { name: "排除公共假期", exact: true });
const policy = name => main.getByRole("button", { name, exact: true });
const payday = () => main.locator(".payday-shortcut");
const countText = card => card.locator(".countdown-number").evaluate(element =>
  [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE)
    .map(node => node.textContent).join("").trim());

async function launch(name, clockDate, { cached = true, initialData } = {}) {
  userData = join(directory, name);
  await mkdir(userData, { recursive: true });
  if (cached) await seedHolidayCache(userData);
  if (initialData) await writeFile(join(userData, "state.json"), JSON.stringify(initialData));
  const env = { ...process.env, TOUCHFISH_USER_DATA: userData,
    TOUCHFISH_KEEP_OPEN: "1", TOUCHFISH_HOLIDAYS_AUTO_REFRESH: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ executablePath: electronPath, args: [harnessPath], env });
  await expect.poll(() => desktop.windows().some(page =>
    page.url().endsWith("/index.html")), { timeout: 15000 }).toBe(true);
  main = desktop.windows().find(page => page.url().endsWith("/index.html"));
  main.setDefaultTimeout(15000);
  main.on("pageerror", error => errors.push(error.message));
  await expect(main.getByText("今日已赚", { exact: true })).toBeVisible();
  await main.clock.install({ time: new Date(clockDate) });
  await main.clock.pauseAt(new Date(new Date(clockDate).getTime() + 1000));
  // Install the clock before the renderer creates its second timer, so the
  // initial dashboard date and later midnight ticks use the same test clock.
  await main.reload();
  await expect(main.getByText("今日已赚", { exact: true })).toBeVisible();
}

async function close() {
  await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await desktop?.close().catch(() => {});
  desktop = undefined;
}

async function openSettings() {
  await main.getByRole("button", { name: "设置", exact: true }).click();
  await expect(main.getByRole("heading", { name: "偏好设置", exact: true })).toBeVisible();
}

async function saveSettings() {
  await main.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(main.getByRole("heading", { name: "偏好设置", exact: true })).toHaveCount(0);
}

async function assertHomeFits() {
  expect(await main.locator(".main-content").evaluate(element => ({
    x: element.scrollWidth > element.clientWidth + 1,
    y: element.scrollHeight > element.clientHeight + 1,
  }))).toEqual({ x: false, y: false });
}

async function jumpTo(value) {
  const delta = new Date(value).getTime() - await main.evaluate(() => Date.now());
  if (delta < 0) throw new Error("The test clock must advance.");
  await main.clock.fastForward(delta);
}

try {
  await launch("cached", "2026-09-15T10:00:00");
  console.log("Checking configurable weekday rest days, validation and alternate-week markers...");
  await openSettings();
  await expect(policy("双休日 周六")).toHaveAttribute("aria-pressed", "true");
  await expect(policy("双休日 周日")).toHaveAttribute("aria-pressed", "true");
  await policy("周一、周二休息").click();
  await expect(policy("双休日 周一")).toHaveAttribute("aria-pressed", "true");
  await expect(policy("双休日 周二")).toHaveAttribute("aria-pressed", "true");
  await expect(restBadge(1)).toHaveText("休息日");
  await expect(restBadge(2)).toHaveText("休息日");
  await expect(restBadge(6)).toHaveCount(0);
  await publicHolidaySwitch().click();
  await saveSettings();
  await expect.poll(async () => (await readData()).settings.doubleRestDays).toEqual([1, 2]);
  await main.getByRole("button", { name: "工作日历", exact: true }).click();
  for (const date of ["2026-09-14", "2026-09-15"])
    await expect(main.getByRole("button", { name: `${date} 休息日`, exact: true })).toHaveClass(/rest/);
  await expect(main.getByRole("button", { name: "2026-09-14 休息日", exact: true })).toContainText("休");
  for (const date of ["2026-09-19", "2026-09-20"])
    await expect(main.getByRole("button", { name: `${date} 工作日`, exact: true })).toBeVisible();
  await main.getByRole("button", { name: "返回", exact: true }).click();

  await openSettings();
  await policy("双休日 周一").click();
  await main.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(main.locator(".validation-errors")).toBeVisible();
  expect((await readData()).settings.doubleRestDays).toEqual([1, 2]);
  await policy("双休日 周一").click();
  await policy("单休").click();
  await main.getByLabel("单休休息日", { exact: true }).selectOption("3");
  await expect(restBadge(3)).toHaveText("休息日");
  await policy("大小周").click();
  await expect(restBadge(1)).toHaveText("双休周休");
  await expect(restBadge(2)).toHaveText("双休周休");
  await expect(restBadge(3)).toHaveText("单休周休");
  await main.locator("input[type=date]").fill("2026-09-14");
  await expect(main.locator(".settings-group").first()).not.toContainText("这周休六、日");
  await saveSettings();
  await main.getByRole("button", { name: "工作日历", exact: true }).click();
  await expect(main.getByRole("button", { name: "2026-09-14 休息日", exact: true })).toBeVisible();
  await expect(main.getByRole("button", { name: "2026-09-16 工作日", exact: true })).toBeVisible();
  await expect(main.getByRole("button", { name: "2026-09-21 工作日", exact: true })).toBeVisible();
  await expect(main.getByRole("button", { name: "2026-09-23 休息日", exact: true })).toBeVisible();
  await main.getByRole("button", { name: "返回", exact: true }).click();

  await jumpTo("2026-09-16T09:00:00");
  await main.getByRole("button", { name: /开始工作/ }).click();
  await jumpTo("2026-09-16T10:00:00");
  await main.getByRole("button", { name: "暂停计时", exact: true }).click();
  await expect.poll(async () => (await readData()).records["2026-09-16"]?.intervals[0].to)
    .toBe(new Date("2026-09-16T10:00:00").getTime());
  const lockedPlan = (await readData()).records["2026-09-16"].plan;

  console.log("Checking all three payday policies against a public holiday...");
  await openSettings();
  await policy("双休").click();
  await publicHolidaySwitch().click();
  await main.getByLabel("每月发薪日", { exact: true }).selectOption("5");
  await policy("提前到最近工作日").click();
  await expect(main.locator(".payroll-preview")).toContainText("2026.09.30");
  await policy("顺延到最近工作日").click();
  await expect(main.locator(".payroll-preview")).toContainText("2026.10.08");
  await policy("当天发薪").click();
  await expect(main.locator(".payroll-preview")).toContainText("2026.10.05");
  await expect(main.locator(".payroll-preview")).toContainText("节假日和休息日不调整");
  await expect(main.locator(".payroll-preview")).not.toContainText("当天为工作日");
  await main.clock.runFor(3000);
  await main.locator(".payroll-settings").scrollIntoViewIfNeeded();
  await main.screenshot({ path: "docs/payday-policy.png", scale: "css" });
  await main.locator(".weekly-rest-picker").scrollIntoViewIfNeeded();
  await main.screenshot({ path: "docs/rest-days.png", scale: "css" });
  await saveSettings();
  await expect.poll(async () => (await readData()).settings.payroll.holidayAdjustment).toBe("none");
  expect((await readData()).records["2026-09-16"].plan).toEqual(lockedPlan);
  await expect(payday()).toContainText("10月5日");
  await expect(payday().locator(".countdown-detail")).not.toContainText("估算");
  await payday().click();
  await expect(main.locator(".payday-actual")).toHaveText("2026.10.05");
  await expect(main.locator(".payday-card")).toContainText("节假日和休息日不调整");
  await main.getByRole("button", { name: "返回", exact: true }).click();
  await main.getByRole("button", { name: "工作日历", exact: true }).click();
  await expect(main.getByRole("button", { name: "2026-09-20 工作日", exact: true })).toContainText("班");
  await main.getByRole("button", { name: "返回", exact: true }).click();
  await assertHomeFits();
  await close();

  console.log("Checking persistence, same-day holiday payment and a Sunday payday...");
  await launch("cached", "2026-10-05T09:00:00");
  await expect.poll(() => countText(payday())).toBe("今天发薪");
  await expect(main.locator(".card-heading .status")).toHaveText("休息日");
  expect((await readData()).settings.doubleRestDays).toEqual([1, 2]);
  expect((await readData()).settings.payroll.holidayAdjustment).toBe("none");
  await jumpTo("2026-11-11T09:00:00");
  await openSettings();
  await policy("周六、周日休息").click();
  await main.getByLabel("每月发薪日", { exact: true }).selectOption("15");
  await saveSettings();
  await expect(payday()).toContainText("11月15日");
  await jumpTo("2026-11-15T09:00:00");
  await expect.poll(() => countText(payday())).toBe("今天发薪");
  await expect(main.locator(".card-heading .status")).toHaveText("休息日");
  await openSettings();
  await policy("周一、周二休息").click();
  await main.getByLabel("每月发薪日", { exact: true }).selectOption("5");
  await saveSettings();
  await expect.poll(async () => (await readData()).settings.doubleRestDays).toEqual([1, 2]);
  const persisted = await readData();
  await close();

  console.log("Checking an uncached calendar does not make a fixed payday uncertain...");
  await launch("empty", "2026-11-11T09:00:00", { cached: false, initialData: persisted });
  await expect(payday()).toContainText("按计划日期发薪");
  await expect(payday()).not.toContainText("日期暂为估算");
  await expect(main.locator(".holiday-estimate-hint")).toBeVisible();
  await payday().click();
  await expect(main.locator(".payday-card")).toContainText("周期工作日和参考日薪暂为估算");
  await expect(main.locator(".payday-card")).not.toContainText("当天为工作日");
  await main.getByRole("button", { name: "返回", exact: true }).click();
  await assertHomeFits();
  expect(errors).toEqual([]);
  console.log("PASS: configurable rest weekdays, alternate markers and calendar, invalid-pair protection, all three payday policies, holiday/Sunday same-day payment, immutable records, persistence and uncached-calendar messaging.");
  console.log(`Isolated data: ${directory}`);
} catch (error) {
  if (main && desktop) {
    console.log(await main.locator("body").ariaSnapshot().catch(() => ""));
    await main.screenshot({ path: ".cache/payday-rest-failure.png", scale: "css" }).catch(() => {});
  }
  throw error;
} finally {
  await close();
}

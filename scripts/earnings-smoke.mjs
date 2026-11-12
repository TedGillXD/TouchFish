import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { seedHolidayCache } from "./test-holiday-cache.mjs";

// Exercise the real application and its read-only companion with isolated data.
// Expectations are calculated here from the requested wage rule, independently
// of the production implementation. No installed app or user records are used.
await mkdir(".cache", { recursive: true });
const directory = await mkdtemp(resolve(".cache/earnings-ui-"));
const settings = {
  monthlySalary: 21000, scheduleMode: "double", restDay: 0,
  doubleRestDays: [6, 0], alternateAnchor: "2026-11-09",
  weekdayHours: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, { start: "09:00", end: "18:00" }])),
  lunch: { enabled: true, start: "12:00", end: "13:00" },
  dinner: { enabled: true, start: "18:00", end: "19:00" },
  publicHolidays: false,
  payroll: { cycleStartDay: 1, payDay: 15, payMonthOffset: 1, holidayAdjustment: "previous" },
  overrides: {},
};
const local = value => new Date(value).getTime();
const fixed = value => value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const errors = [];
let desktop, main, floating, userData;
const readData = async () => JSON.parse(await readFile(join(userData, "state.json"), "utf8"));
const amount = () => main.locator(".earnings > span").nth(1);

async function bounded(label, callback, timeout = 20000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(callback),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function stop() {
  if (!desktop) return;
  const current = desktop;
  const child = current.process();
  desktop = undefined;
  await bounded("quit isolated app", () => current.evaluate(({ app }) => app.exit(0)), 5000)
    .catch(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await bounded("close isolated connection", () => current.close(), 5000)
    .catch(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
}

async function launch(name, date, initial) {
  userData = join(directory, name);
  await mkdir(userData, { recursive: true });
  await seedHolidayCache(userData);
  if (initial) await writeFile(join(userData, "state.json"), JSON.stringify(initial));
  const env = { ...process.env, TOUCHFISH_USER_DATA: userData,
    TOUCHFISH_KEEP_OPEN: "1", TOUCHFISH_HOLIDAYS_AUTO_REFRESH: "0" };
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ executablePath: electronPath, args: ["."], env });
  await expect.poll(() => desktop.windows().some(page => page.url().endsWith("/index.html"))).toBe(true);
  main = desktop.windows().find(page => page.url().endsWith("/index.html"));
  main.setDefaultTimeout(15000);
  main.on("pageerror", error => errors.push(error.message));
  if (process.platform === "win32") {
    await expect.poll(() => desktop.windows().some(page => page.url().includes("window=floating"))).toBe(true);
    floating = desktop.windows().find(page => page.url().includes("window=floating"));
    floating.setDefaultTimeout(15000);
    floating.on("pageerror", error => errors.push(error.message));
  } else floating = undefined;
  await expect(main.getByText("今日已赚", { exact: true })).toBeVisible();
  await main.clock.install({ time: new Date(local(date) - 1000) });
  await main.clock.pauseAt(new Date(date));
  await main.reload();
  await expect(main.getByText("今日已赚", { exact: true })).toBeVisible();
  if (floating && await floating.getByRole("button", { name: "展开悬浮窗" }).count())
    await floating.getByRole("button", { name: "展开悬浮窗" }).click();
}

async function jump(date) {
  const delta = local(date) - await main.evaluate(() => Date.now());
  if (delta < 0) throw new Error("Test clock must advance monotonically.");
  await bounded("advance test clock", () => main.clock.fastForward(delta));
}

async function moneyIs(expected) {
  await expect(amount()).toHaveText(fixed(expected));
  if (floating) await expect(floating.locator(".floating-earnings")).toHaveText(`¥${fixed(expected)}`);
}

async function durationIs(expected) {
  await expect(main.locator(".mono")).toHaveText(expected);
  if (floating) await expect(floating.locator(".floating-duration")).toHaveText(expected);
}

async function fullTarget(expected, realDuration) {
  await expect(main.getByText("今天辛苦了，好好休息", { exact: true })).toBeVisible();
  await moneyIs(expected);
  await durationIs(realDuration);
  await expect(main.getByRole("progressbar", { name: "今日上班进度" })).toHaveAttribute("aria-valuenow", "100");
  if (floating) {
    await expect(floating.locator(".floating-status")).toHaveText("已下班");
    await expect(floating.locator(".floating-percent")).toHaveText("100.0%");
  }
}

function legacy(date, dailyWage, completed) {
  return { date, completed, plan: {
    working: true, start: local(`${date}T09:00:00`), end: local(`${date}T18:00:00`),
    breakStart: local(`${date}T12:00:00`), breakEnd: local(`${date}T13:00:00`),
    dinnerStart: null, dinnerEnd: null, plannedSeconds: 28800, workdays: 21,
    dailyWage, perSecond: dailyWage / 28800, periodStart: "2026-11-01", periodEnd: "2026-11-30",
  }, intervals: [{ from: local(`${date}T10:00:00`), to: local(`${date}T11:00:00`) }] };
}

try {
  console.log("Checking immediate pre-schedule accrual and a frozen first-start rate...");
  await launch("live", "2026-11-12T08:30:00", { version: 1, settings, records: {} });
  await moneyIs(0);
  await main.getByRole("button", { name: /开始工作/ }).click();
  await expect(main.getByText("正在工作", { exact: true })).toBeVisible();
  await expect.poll(async () => (await readData()).records["2026-11-12"]?.intervals.length).toBe(1);
  const firstPlan = (await readData()).records["2026-11-12"].plan;
  const rate = 1000 / (9.5 * 3600 - 3600);
  expect(firstPlan.dailyWage).toBe(1000);
  expect(firstPlan.perSecond).toBeCloseTo(rate, 12);
  await main.clock.runFor(2000);
  await durationIs("00:00:02");
  await moneyIs(rate * 2);
  await main.getByRole("button", { name: "暂停计时", exact: true }).click();
  await jump("2026-11-12T09:00:00");
  await moneyIs(rate * 2);
  await main.getByRole("button", { name: /继续工作/ }).click();
  await main.clock.runFor(2000);
  await durationIs("00:00:04");
  await moneyIs(rate * 4);
  await main.getByRole("button", { name: "暂停计时", exact: true }).click();
  expect((await readData()).records["2026-11-12"].plan).toEqual(firstPlan);
  await jump("2026-11-12T17:59:59");
  await moneyIs(rate * 4);
  await durationIs("00:00:04");
  await main.clock.runFor(1000);
  await fullTarget(1000, "00:00:04");
  await expect.poll(async () => (await readData()).records["2026-11-12"].completed).toBe(true);

  console.log("Checking midnight resets today, late start and explicit finish settlement...");
  await jump("2026-11-13T00:00:01");
  await expect(main.getByRole("button", { name: /开始工作/ })).toBeVisible();
  await moneyIs(0);
  await durationIs("00:00:00");
  if (floating) await expect(floating.locator(".floating-status")).toHaveText("未开始");
  expect((await readData()).records["2026-11-13"]).toBeUndefined();
  await jump("2026-11-13T16:00:00");
  await main.getByRole("button", { name: /开始工作/ }).click();
  await main.clock.runFor(1000);
  await durationIs("00:00:01");
  await moneyIs(1000 / 7200);
  await main.getByRole("button", { name: "下班", exact: true }).click();
  await expect(main.getByRole("dialog")).toContainText(/补齐|目标|结算/);
  await main.getByRole("button", { name: "确认下班", exact: true }).click();
  await fullTarget(1000, "00:00:01");
  await main.getByRole("button", { name: /周期已记录/ }).click();
  await expect(main.locator(".history-total strong")).toHaveText("¥2,000.00");
  await expect(main.locator(".history-row")).toHaveCount(2);
  await expect(main.locator(".history-row").first()).toContainText("00:00:01");
  for (const row of await main.locator(".history-row").all()) await expect(row.locator("strong").last()).toHaveText("¥1,000.00");
  await main.getByRole("button", { name: "返回", exact: true }).click();
  await main.getByRole("button", { name: "薪资周期", exact: true }).click();
  await expect(main.locator(".payroll-total strong")).toHaveText("¥2,000.00");
  await stop();
  await launch("live", "2026-11-13T16:01:00");
  await fullTarget(1000, "00:00:01");
  await stop();

  console.log("Checking offline/legacy end settlement preserves original targets and real time...");
  await launch("legacy", "2026-11-12T08:30:00", { version: 1, settings, records: {
    "2026-11-10": legacy("2026-11-10", 900, true),
    "2026-11-11": legacy("2026-11-11", 1100, false),
  } });
  await moneyIs(0);
  await expect(main.getByRole("button", { name: /开始工作/ })).toBeVisible();
  await expect.poll(async () => (await readData()).records["2026-11-11"].completed).toBe(true);
  const restored = await readData();
  expect(Object.keys(restored.records).sort()).toEqual(["2026-11-10", "2026-11-11"]);
  expect(restored.records["2026-11-10"].plan.dailyWage).toBe(900);
  expect(restored.records["2026-11-11"].plan.dailyWage).toBe(1100);
  await main.getByRole("button", { name: /周期已记录/ }).click();
  await expect(main.locator(".history-total strong")).toHaveText("¥2,000.00");
  await expect(main.locator(".history-row")).toHaveCount(2);
  await expect(main.locator(".history-row").first()).toContainText("01:00:00");
  await expect(main.locator(".history-row").first().locator("strong").last()).toHaveText("¥1,100.00");
  await expect(main.locator(".history-row").last().locator("strong").last()).toHaveText("¥900.00");
  await main.getByRole("button", { name: "返回", exact: true }).click();
  await main.getByRole("button", { name: "薪资周期", exact: true }).click();
  await expect(main.locator(".payroll-total strong")).toHaveText("¥2,000.00");
  expect(errors).toEqual([]);
  console.log("PASS: immediate early/late start rates, pause/resume snapshot, paused scheduled settlement, full target with truthful seconds, midnight reset, explicit finish, history/period totals, disk restart and legacy offline correction.");
} catch (error) {
  console.error(error);
  if (main && !main.isClosed()) await bounded("capture failure", async () => console.error(await main.locator("body").ariaSnapshot()), 2000).catch(() => {});
  throw error;
} finally { await stop(); }

import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { seedHolidayCache } from "./test-holiday-cache.mjs";

// The real application runs against isolated files and a test-only Session
// handler. No requests escape to the public internet and OS proxy/TLS remain
// unchanged, including when the clock advances into an unpublished year.
await mkdir(".cache", { recursive: true });
const directory = await mkdtemp(resolve(".cache/countdown-ui-"));
const harnessPath = join(directory, "countdown-harness.cjs");
const fixturePath = resolve("tests/fixtures/china-holidays.json");
const mainPath = resolve("dist-electron/main.cjs");
await writeFile(harnessPath, `
const { app, session } = require('electron');
const { readFileSync } = require('node:fs');
app.setPath('userData', process.env.TOUCHFISH_USER_DATA);
const fixtures = JSON.parse(readFileSync(${JSON.stringify(fixturePath)}, 'utf8'));
let mode = 'offline';
globalThis.countdownFixture = { setMode(value) { mode = value; } };
app.whenReady().then(() => {
  session.fromPartition('touchfish-holidays', { cache: false }).protocol.handle('https', request => {
    const url = new URL(request.url);
    if (!['raw.githubusercontent.com', 'cdn.jsdelivr.net'].includes(url.hostname))
      return new Response('', { status: 403 });
    if (mode === 'offline') return new Response('', { status: 503 });
    const year = Number(url.pathname.split('/').at(-1)?.replace('.json', ''));
    const data = structuredClone(fixtures.find(item => item.year === year));
    if (!data) return new Response('', { status: 404 });
    if (year === 2026 && mode === 'earlier-holiday')
      data.days.push({ date: '2026-11-12', name: '测试假期', isOffDay: true });
    return new Response(JSON.stringify(data), { status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  });
  require(${JSON.stringify(mainPath)});
}).catch(error => { console.error(error); app.exit(1); });
`, "utf8");

let desktop;
let main;
const errors = [];
async function launch(cached) {
  const userData = join(directory, cached ? "cached-data" : "empty-data");
  await mkdir(userData, { recursive: true });
  if (cached) await seedHolidayCache(userData);
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
  await main.clock.install({ time: new Date("2026-11-11T09:00:00") });
  await main.clock.pauseAt(new Date("2026-11-11T09:00:01"));
  return userData;
}

const holiday = () => main.locator(".holiday-countdown");
const payday = () => main.locator(".payday-shortcut");
const number = card => card.locator(".countdown-number");
const expectCount = (card, value) => expect.poll(() => number(card).evaluate(element =>
  [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE)
    .map(node => node.textContent).join("").trim())).toBe(value);

async function jumpTo(value) {
  const delta = new Date(value).getTime() - await main.evaluate(() => Date.now());
  if (delta < 0) throw new Error("The test clock must only advance.");
  await main.clock.fastForward(delta);
}

async function assertFits() {
  const size = await desktop.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().find(win =>
      win.webContents.getURL().endsWith("/index.html")).getBounds());
  expect(size.width).toBe(440);
  expect(size.height).toBe(680);
  const metrics = await main.locator(".main-content").evaluate(element => ({
    height: element.clientHeight,
    total: element.scrollHeight,
    children: [...element.children].map(child => ({
      className: child.className,
      height: child.getBoundingClientRect().height,
      top: child.getBoundingClientRect().top,
      bottom: child.getBoundingClientRect().bottom,
    })),
  }));
  if (metrics.total > metrics.height + 1) {
    console.log(JSON.stringify(metrics));
    await main.screenshot({ path: ".cache/countdown-overflow.png", scale: "css" });
  }
  expect(await main.locator(".main-content").evaluate(element => ({
    vertical: element.scrollHeight > element.clientHeight + 1,
    horizontal: element.scrollWidth > element.clientWidth + 1,
  }))).toEqual({ vertical: false, horizontal: false });
  for (const card of [holiday(), payday()]) {
    expect(await card.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const area = document.querySelector(".main-content").getBoundingClientRect();
      return bounds.top >= area.top && bounds.bottom <= area.bottom + 1;
    })).toBe(true);
  }
}

async function close() {
  await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await desktop?.close().catch(() => {});
  desktop = undefined;
}

try {
  await launch(true);
  console.log("Checking highlighted holiday and adjusted-payday countdowns...");
  await expectCount(holiday(), "51");
  await expect(holiday()).toContainText("元旦");
  await expectCount(payday(), "2");
  await expect(payday()).toContainText("11月13日");
  const colors = await Promise.all([holiday(), payday()].map(card => number(card).evaluate(element =>
    getComputedStyle(element).color.match(/\d+/g).slice(0, 3).map(Number))));
  expect(colors[0][0]).toBeGreaterThan(colors[0][1]);
  expect(colors[0][1]).toBeGreaterThan(colors[0][2]);
  expect(colors[1][1]).toBeGreaterThan(colors[1][0]);
  await assertFits();

  await main.getByRole("button", { name: /开始工作/ }).click();
  await jumpTo("2026-11-11T10:37:00");
  await main.getByRole("button", { name: "暂停计时", exact: true }).click();
  await assertFits();
  await main.screenshot({ path: "docs/countdowns.png", scale: "css" });
  await main.getByRole("button", { name: "隐藏金额", exact: true }).click();
  await expect(main.locator(".earnings")).toContainText("••••");
  await expectCount(holiday(), "51");
  await expectCount(payday(), "2");

  console.log("Checking countdown shortcuts open the corresponding calendar and earning cycle...");
  await holiday().click();
  await expect(main.locator(".calendar-navigation h2")).toContainText("2027年 1月");
  await expect(main.locator(".override-panel h3")).toContainText("2027.01.01");
  await main.getByRole("button", { name: "返回", exact: true }).click();
  await payday().click();
  await expect(main.locator(".payroll-range")).toHaveText("2026.10.01 — 2026.10.31");
  await expect(main.locator(".payday-actual")).toContainText("2026.11.13");
  await main.getByRole("button", { name: "返回", exact: true }).click();

  console.log("Checking midnight, today-payday and holiday-in-progress labels...");
  await jumpTo("2026-11-12T00:00:01");
  await expectCount(holiday(), "50");
  await expectCount(payday(), "1");
  await jumpTo("2026-11-13T00:00:01");
  await expectCount(payday(), "今天发薪");
  await jumpTo("2027-01-01T09:00:01");
  await expectCount(holiday(), "假期中");
  await expect(holiday()).toContainText("元旦");
  await jumpTo("2027-01-04T09:00:01");
  await expectCount(holiday(), "32");
  await expect(holiday()).toContainText("春节");
  await assertFits();
  await close();

  await launch(false);
  console.log("Checking missing data and later downloaded-calendar broadcasts...");
  await expectCount(holiday(), "待更新");
  expect(await holiday().innerText()).not.toMatch(/\b0\s*天/);
  await holiday().click();
  await expect(main.getByRole("heading", { name: "偏好设置", exact: true })).toBeVisible();
  await main.getByRole("button", { name: "返回", exact: true }).click();
  await desktop.evaluate(() => globalThis.countdownFixture.setMode("good"));
  await main.evaluate(() => window.touchFish.holidays.refresh([2026, 2027], true));
  await expectCount(holiday(), "51");
  await main.getByRole("button", { name: "设置", exact: true }).click();
  await main.getByRole("switch", { name: "排除公共假期", exact: true }).click();
  await main.getByRole("button", { name: "保存设置", exact: true }).click();
  await expectCount(holiday(), "51");
  await desktop.evaluate(() => globalThis.countdownFixture.setMode("earlier-holiday"));
  await main.evaluate(() => window.touchFish.holidays.refresh([2026], true));
  await expectCount(holiday(), "1");
  await expect(holiday()).toContainText("测试假期");
  await main.clock.runFor(3000);
  await assertFits();
  expect(errors).toEqual([]);
  console.log("PASS: highlighted calendar-day countdowns, adjusted payday, midnight/today/ongoing states, targeted navigation, privacy, no-cache recovery, dynamic broadcasts and 440×680 first-screen layout.");
  console.log(`Isolated data: ${directory}`);
} finally {
  await close();
}

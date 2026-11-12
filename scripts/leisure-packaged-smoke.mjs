import { _electron as electron, expect } from "@playwright/test";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { seedHolidayCache } from "./test-holiday-cache.mjs";

const executablePath = process.env.TOUCHFISH_EXECUTABLE || process.argv[2];
if (!executablePath) throw new Error("Provide a packaged executable as the first argument or TOUCHFISH_EXECUTABLE.");
await mkdir(".cache", { recursive: true });
const userData = await mkdtemp(resolve(".cache/leisure-packaged-"));
await seedHolidayCache(userData);
const extensionFiles = await readdir(join(dirname(resolve(executablePath)), "resources", "youtube-companion"));
for (const file of ["manifest.json", "background.js", "content.js", "launch.html"]) expect(extensionFiles).toContain(file);
const env = { ...process.env, TOUCHFISH_USER_DATA: userData, TOUCHFISH_KEEP_OPEN: "1", TOUCHFISH_HOLIDAYS_AUTO_REFRESH: "0" };
delete env.ELECTRON_RUN_AS_NODE;
let desktop;
try {
  desktop = await electron.launch({ executablePath: resolve(executablePath), args: [], env });
  await expect.poll(() => desktop.windows().some(page => page.url().endsWith("/index.html"))).toBe(true);
  const main = desktop.windows().find(page => page.url().endsWith("/index.html"));
  await expect(main.getByText("今日已赚", { exact: true })).toBeVisible();
  const state = await main.evaluate(() => window.touchFish.youtube.getState());
  expect(state.connected).toBe(false); expect(state.open).toBe(false);
  const shortcut = await main.evaluate(() => window.touchFish.bossKey.getState());
  expect(shortcut.registered).toBe(true);
  await main.evaluate(() => window.touchFish.bossKey.trigger());
  await expect.poll(async () => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible() || window.isMinimized()))).toBe(true);
  await main.evaluate(() => window.touchFish.bossKey.restore());
  await expect.poll(async () => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.webContents.getURL().endsWith("/index.html") && window.isVisible() && !window.isMinimized()))).toBe(true);
  await main.getByRole("button", { name: "摸鱼", exact: true }).click();
  await main.getByRole("tab", { name: "YouTube", exact: true }).click();
  await expect(main.getByRole("region", { name: "YouTube浏览器连接", exact: true }).getByText("未连接", { exact: true })).toBeVisible();
  console.log("PASS: packaged startup, companion resources, disconnected YouTube service, real shortcut registration, all-window conceal/restore, and YouTube route.");
} finally {
  await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await desktop?.close().catch(() => {});
}

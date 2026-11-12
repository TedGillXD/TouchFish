import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createBilibiliDesktopFixture } from "./bilibili-desktop-fixture.mjs";

const knownBvid = "BV17x411w7KC";
const missingBvid = "BV1xx411c7mD";
const lateBvid = "BV1Q541167Qg";
const clearBvid = "BV1GJ411x7h7";
const { userData, harnessPath } = await createBilibiliDesktopFixture({ prefix: ".cache/bilibili-history-" });
// Extend this generated harness only. Shared fixtures and the operating system's
// networking are untouched; delayed replies still travel through real local TLS.
let harness = await readFile(harnessPath, "utf8");
const requireNeedle = "let qr='waiting',media='good',delayPlay=false;";
expect(harness).toContain(requireNeedle);
harness = harness.replace(requireNeedle, `
let historyViewDelay=false;const historyViewReleases=[];
globalThis.biliHistoryNetworkProbe={delay:()=>{historyViewDelay=true;},release:()=>{historyViewDelay=false;for(const release of historyViewReleases.splice(0))release();},get pending(){return historyViewReleases.length;}};
${requireNeedle}`);
const viewNeedle = "const bvid=url.searchParams.get('bvid');";
expect(harness).toContain(viewNeedle);
harness = harness.replace(viewNeedle, `${viewNeedle}
    if(historyViewDelay)await new Promise(resolve=>historyViewReleases.push(resolve));`);
const knownNeedle = "if(bvid!=='BV17x411w7KC')";
expect(harness).toContain(knownNeedle);
harness = harness.replace(knownNeedle, `if(!${JSON.stringify([knownBvid, lateBvid, clearBvid])}.includes(bvid))`);
await writeFile(harnessPath, harness, "utf8");

const env = { ...process.env, TOUCHFISH_USER_DATA: userData, TOUCHFISH_KEEP_OPEN: "1", TOUCHFISH_HOLIDAYS_AUTO_REFRESH: "0" };
delete env.ELECTRON_RUN_AS_NODE;
let desktop, main, player, floating;
const errors = [];
const history = () => main.evaluate(() => window.touchFish.bilibili.getHistory());
const rows = () => main.locator(".bili-history-item");
const row = bvid => main.locator(`.bili-history-item[data-bvid="${bvid}"]`);
const probe = operation => desktop.evaluate((_electron, operation) => globalThis.biliHistoryNetworkProbe[operation](), operation);

async function launch() {
  desktop = await electron.launch({ executablePath: electronPath, args: [harnessPath], env });
  await expect.poll(() => desktop.windows().some(page => page.url().endsWith("/index.html")), { timeout: 15000 }).toBe(true);
  main = desktop.windows().find(page => page.url().endsWith("/index.html"));
  main.setDefaultTimeout(15000);
  main.on("pageerror", error => errors.push(error.message));
  await expect(main.getByText("今日已赚", { exact: true })).toBeVisible();
  if (process.platform === "win32") {
    await expect.poll(() => desktop.windows().some(page => page.url().includes("window=floating"))).toBe(true);
    floating = desktop.windows().find(page => page.url().includes("window=floating"));
  }
  await main.getByRole("button", { name: "摸鱼", exact: true }).click();
  await expect(main.getByRole("heading", { name: "摸鱼 · B 站", exact: true })).toBeVisible();
  await expect(main.getByRole("region", { name: "B站历史记录", exact: true })).toBeVisible();
}
async function quit() {
  const current = desktop;
  const closed = current.waitForEvent("close", { timeout: 15000 });
  await main.evaluate(() => window.touchFish.quit());
  await closed;
  await current.close().catch(() => {});
  desktop = main = player = floating = undefined;
}
async function lookup(input) {
  await main.bringToFront();
  const field = main.getByLabel("BV号或视频链接", { exact: true });
  await field.fill(input);
  await expect(field).toHaveValue(input);
  await main.getByRole("button", { name: "查找视频", exact: true }).click();
}
async function deleteRow(bvid) {
  await row(bvid).getByRole("button", { name: `删除记录 ${bvid}`, exact: true }).click();
  await expect(row(bvid)).toHaveCount(0);
}
async function pendingView() {
  await expect.poll(() => desktop.evaluate(() => globalThis.biliHistoryNetworkProbe.pending)).toBeGreaterThan(0);
}
async function delayPlayback() {
  await desktop.evaluate(() => globalThis.biliFixture.setPlayDelay(true));
  await main.getByRole("button", { name: "看视频", exact: true }).click();
  await expect.poll(() => desktop.evaluate(() => globalThis.biliFixture.playPending)).toBeGreaterThan(0);
}
async function releasePlayback() {
  await desktop.evaluate(() => globalThis.biliFixture.releasePlay());
  await expect.poll(() => desktop.windows().some(page => page.url().includes("window=player"))).toBe(true);
  await expect(main.getByRole("button", { name: "看视频", exact: true })).toBeEnabled();
  await main.evaluate(() => window.touchFish.bilibili.closePlayer());
  await expect.poll(() => desktop.windows().some(page => page.url().includes("window=player"))).toBe(false);
}

try {
  await launch();
  console.log("Checking anonymous search history, input validation, metadata and BV deduplication...");
  expect((await main.evaluate(() => window.touchFish.bilibili.getAuth())).loggedIn).toBe(false);
  await expect(main.getByText("还没有记录", { exact: true })).toBeVisible();
  await lookup("not-a-bv");
  await expect(main.locator(".bili-panel-error")).toContainText("BV");
  expect((await history()).entries).toEqual([]);
  await lookup(knownBvid);
  await expect(main.locator(".bili-video-info")).toContainText("TouchFish · B站播放演示");
  await expect(row(knownBvid)).toContainText("TouchFish · B站播放演示");
  let entry = (await history()).entries.find(entry => entry.bvid === knownBvid);
  expect(entry.lastSearchedAt).toBeGreaterThan(0);
  expect(entry.lastPlayedAt).toBeNull();
  expect(entry.owner).toBe("TouchFish 演示");
  expect(entry.duration).toBe(40);
  const firstSearch = entry.lastSearchedAt;
  await lookup(`https://www.bilibili.com/video/${knownBvid}`);
  await expect(main.locator(".bili-video-info")).toContainText(knownBvid);
  await expect(rows()).toHaveCount(1);
  expect((await history()).entries[0].lastSearchedAt).toBeGreaterThanOrEqual(firstSearch);
  await lookup(missingBvid);
  await expect(main.locator(".bili-panel-error")).toContainText("视频");
  await expect(row(missingBvid)).toBeVisible();
  expect((await history()).entries.map(entry => entry.bvid)).toEqual([missingBvid, knownBvid]);
  expect((await history()).entries[0].lastPlayedAt).toBeNull();
  await main.screenshot({ path: ".cache/bilibili-history-panel.png", scale: "css" });

  console.log("Checking search persistence, selecting history, playback mode/part and narrow history IPC...");
  await quit();
  await launch();
  expect((await history()).entries).toHaveLength(2);
  await row(knownBvid).getByRole("button", { name: `重新查找 ${knownBvid}`, exact: true }).click();
  await expect(main.getByLabel("BV号或视频链接", { exact: true })).toHaveValue(knownBvid);
  await expect(main.locator(".bili-video-info")).toContainText(knownBvid);
  await main.getByLabel("视频分P", { exact: true }).selectOption("102");
  await main.getByRole("button", { name: "听视频", exact: true }).click();
  await expect.poll(() => desktop.windows().some(page => page.url().includes("window=player"))).toBe(true);
  player = desktop.windows().find(page => page.url().includes("window=player"));
  player.on("pageerror", error => errors.push(error.message));
  await expect.poll(() => player.evaluate(() => {
    const audio = document.querySelector("audio");
    return !!audio && audio.readyState >= 2 && !audio.paused && audio.currentTime > .1;
  })).toBe(true);
  await expect.poll(async () => (await history()).entries.find(entry => entry.bvid === knownBvid)?.lastMode).toBe("audio");
  entry = (await history()).entries.find(entry => entry.bvid === knownBvid);
  expect(entry.lastPlayedAt).toBeGreaterThan(0);
  expect(entry.lastCid).toBe(102);
  for (const page of [player, floating].filter(Boolean)) {
    expect(await page.evaluate(async bvid => {
      const denied = async callback => { try { await callback(); return false; } catch { return true; } };
      return {
        get: await denied(() => window.touchFish.bilibili.getHistory()),
        remove: await denied(() => window.touchFish.bilibili.removeHistory(bvid)),
        clear: await denied(() => window.touchFish.bilibili.clearHistory()),
      };
    }, knownBvid)).toEqual({ get: true, remove: true, clear: true });
  }
  await deleteRow(knownBvid);
  await player.evaluate(bvid => window.touchFish.bilibili.play({ bvid, cid: 102, mode: "audio" }), knownBvid);
  expect((await history()).entries.some(entry => entry.bvid === knownBvid)).toBe(false);
  // Only another explicit action in the full panel creates the removed entry.
  await main.getByRole("button", { name: "听视频", exact: true }).click();
  await expect.poll(async () => (await history()).entries.find(entry => entry.bvid === knownBvid)?.lastMode).toBe("audio");
  await main.evaluate(() => window.touchFish.bilibili.closePlayer());
  await expect.poll(() => desktop.windows().some(page => page.url().includes("window=player"))).toBe(false);
  player = undefined;
  await row(knownBvid).getByRole("button", { name: `重新查找 ${knownBvid}`, exact: true }).click();
  await expect(main.getByLabel("视频分P", { exact: true })).toHaveValue("102");
  expect(desktop.windows().some(page => page.url().includes("window=player"))).toBe(false);
  const stored = await readFile(join(userData, "bilibili-history.json"), "utf8");
  expect(stored).not.toMatch(/SESSDATA|cookie|touchfish-media|bilivideo\.com|audioUrl|videoUrl|expiresAt/i);

  console.log("Checking individual deletion, late metadata replies, clear confirmation and restart...");
  await deleteRow(missingBvid);
  await quit();
  await launch();
  expect((await history()).entries.map(entry => entry.bvid)).toEqual([knownBvid]);

  // A resolved playback can still open after deletion, but it must not recreate
  // the user's deleted history or alter a fresh search made in the meantime.
  await row(knownBvid).getByRole("button", { name: `重新查找 ${knownBvid}`, exact: true }).click();
  await expect(main.locator(".bili-video-info")).toContainText(knownBvid);
  await delayPlayback();
  await deleteRow(knownBvid);
  await releasePlayback();
  expect((await history()).entries).toEqual([]);
  await lookup(knownBvid);
  await expect(main.locator(".bili-video-info")).toContainText(knownBvid);
  await delayPlayback();
  await main.getByRole("button", { name: "清空记录", exact: true }).click();
  await main.getByRole("button", { name: "确认清空", exact: true }).click();
  await releasePlayback();
  expect((await history()).entries).toEqual([]);
  await lookup(knownBvid);
  await expect(main.locator(".bili-video-info")).toContainText(knownBvid);

  await probe("delay");
  await lookup(lateBvid);
  await pendingView();
  await expect(row(lateBvid)).toBeVisible();
  await deleteRow(lateBvid);
  await probe("release");
  await expect(main.locator(".bili-video-info")).toContainText(lateBvid);
  expect((await history()).entries.some(entry => entry.bvid === lateBvid)).toBe(false);

  await main.getByRole("button", { name: "清空记录", exact: true }).click();
  await expect(main.getByText("确认清空全部记录？", { exact: true })).toBeVisible();
  await main.getByRole("button", { name: "取消清空", exact: true }).click();
  expect((await history()).entries).toHaveLength(1);
  await probe("delay");
  await lookup(clearBvid);
  await pendingView();
  await expect(row(clearBvid)).toBeVisible();
  await main.getByRole("button", { name: "清空记录", exact: true }).click();
  await main.getByRole("button", { name: "确认清空", exact: true }).click();
  await expect(main.getByText("还没有记录", { exact: true })).toBeVisible();
  await probe("release");
  await expect(main.locator(".bili-video-info")).toContainText(clearBvid);
  expect((await history()).entries).toEqual([]);
  await quit();
  await launch();
  await expect(main.getByText("还没有记录", { exact: true })).toBeVisible();
  expect((await history()).entries).toEqual([]);
  expect(errors).toEqual([]);
  console.log("PASS: anonymous persistent search/play history, BV deduplication, failed lookup retention, explicit re-open and selected part, managed deletion/clear with late replies, narrow IPC and clean restart.");
} finally {
  await desktop?.evaluate(() => globalThis.biliHistoryNetworkProbe.release()).catch(() => {});
  await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await desktop?.close().catch(() => {});
}

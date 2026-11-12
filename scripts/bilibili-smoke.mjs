import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { createBilibiliDesktopFixture } from "./bilibili-desktop-fixture.mjs";

const { userData, harnessPath, workDate } = await createBilibiliDesktopFixture();

const env = { ...process.env, TOUCHFISH_USER_DATA: userData, TOUCHFISH_KEEP_OPEN: "1", TOUCHFISH_HOLIDAYS_AUTO_REFRESH: "0" };
delete env.ELECTRON_RUN_AS_NODE;
let desktop;
let main;
let player;
let floating;
const errors = [];
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
    floating.setDefaultTimeout(15000);
    floating.on("pageerror", error => errors.push(error.message));
    await floatingSize(164, 44);
    await expect(floating.locator(".floating-media-toggle")).toHaveCount(0);
    if (await main.getByRole("button", { name: /开始工作/ }).count())
      await main.getByRole("button", { name: /开始工作/ }).click();
    await expect(main.getByRole("button", { name: "暂停计时", exact: true })).toBeVisible();
  }
  await main.getByRole("button", { name: "摸鱼", exact: true }).click();
  await expect(main.getByRole("heading", { name: "摸鱼 · B 站", exact: true })).toBeVisible();
}
async function close() {
  await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await desktop?.close().catch(() => {});
  desktop = undefined;
}
async function floatingSize(width, height) {
  if (!floating) return;
  await expect.poll(() => desktop.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes("window=floating"));
    const bounds = win.getBounds();
    return { width: bounds.width, height: bounds.height };
  })).toEqual({ width, height });
  expect(await floating.evaluate(() => ({ x: document.documentElement.scrollWidth > innerWidth, y: document.documentElement.scrollHeight > innerHeight })))
    .toEqual({ x: false, y: false });
}
const transport = () => floating.evaluate(() => window.touchFish.bilibili.getTransportState());
const mediaToggle = (playing) => floating.getByRole("button", { name: playing ? "暂停B站播放" : "继续B站播放", exact: true });
async function transportIs(playing) {
  if (!floating) return;
  await expect.poll(async () => {
    const state = await transport();
    return state.open && state.ready && state.playIntent === playing;
  }).toBe(true);
  await expect(mediaToggle(playing)).toBeEnabled();
}
async function quitNormally() {
  const closed = desktop.waitForEvent("close", { timeout: 15000 });
  await main.evaluate(() => window.touchFish.quit());
  await closed;
  desktop = undefined;
}
const fixture = (key, value) => desktop.evaluate((_electron, { key, value }) => globalThis.biliFixture[key](value), { key, value });
const media = () => player.evaluate(() => ({
  video: { ready: document.querySelector("video").readyState, time: document.querySelector("video").currentTime, paused: document.querySelector("video").paused, muted: document.querySelector("video").muted, source: document.querySelector("video").getAttribute("src"), rate: document.querySelector("video").playbackRate },
  audio: { ready: document.querySelector("audio").readyState, time: document.querySelector("audio").currentTime, paused: document.querySelector("audio").paused, muted: document.querySelector("audio").muted, source: document.querySelector("audio").getAttribute("src"), rate: document.querySelector("audio").playbackRate },
}));
async function playing(mode) {
  await expect.poll(async () => { const value = await media(); return mode === "video" ? value.video.ready >= 2 && value.audio.ready >= 2 && !value.video.paused && !value.audio.paused : value.audio.ready >= 2 && !value.audio.paused && !value.video.source; }, { timeout: 15000 }).toBe(true);
}
async function hover() {
  const size = player.viewportSize() ?? await player.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await player.mouse.move(size.width / 2, size.height / 2);
}
async function openPlayer(mode) {
  await main.getByRole("button", { name: mode === "video" ? "看视频" : "听视频", exact: true }).click();
  await expect.poll(() => desktop.windows().some(page => page.url().includes("window=player")), { timeout: 15000 }).toBe(true);
  player = desktop.windows().find(page => page.url().includes("window=player"));
  player.setDefaultTimeout(15000);
  player.on("pageerror", error => errors.push(error.message));
  await expect(player.locator(".bili-player")).toBeVisible();
}
async function closePlayer() {
  const lastTransport = floating ? await transport() : null;
  const closed = player.waitForEvent("close");
  // Native close can destroy the CDP target before the click acknowledgement.
  await player.getByRole("button", { name: "关闭播放器", exact: true }).click().catch(error => { if (!player.isClosed()) throw error; });
  await closed;
  await expect.poll(() => desktop.windows().some(page => page.url().includes("window=player"))).toBe(false);
  if (floating) {
    await expect.poll(async () => (await transport()).open).toBe(false);
    await expect(floating.locator(".floating-media-toggle")).toHaveCount(0);
    await floatingSize(164, 44);
    await expect(floating.evaluate(async revision => window.touchFish.bilibili.setPlaying(true, revision), lastTransport.revision)).rejects.toThrow();
  }
}

try {
  await launch();
  console.log("Checking generated QR, expiry, scan confirmation and isolated login persistence...");
  await main.getByRole("button", { name: "获取二维码", exact: true }).click();
  await expect(main.getByAltText("B站扫码登录二维码")).toBeVisible();
  expect(await main.getByAltText("B站扫码登录二维码").evaluate(image => image.complete && image.naturalWidth >= 200)).toBe(true);
  await main.screenshot({ path: "docs/bilibili-panel.png", scale: "css" });
  await fixture("setQr", "expired");
  await expect(main.locator(".bili-auth-message")).toContainText("过期");
  await fixture("setQr", "waiting");
  await main.getByRole("button", { name: "获取二维码", exact: true }).click();
  await fixture("setQr", "scanned");
  await expect(main.locator(".bili-auth-message")).toContainText("手机端确认");
  await fixture("setQr", "confirmed");
  await expect(main.locator(".bili-account-name")).toContainText("演示用户");
  expect(await main.evaluate(async () => JSON.stringify(await window.touchFish.bilibili.getAuth()).includes("fixture-only"))).toBe(false);
  await quitNormally();
  await launch();
  await expect(main.locator(".bili-account-name")).toContainText("演示用户");

  console.log("Checking BV validation, metadata and decoded separate video/audio streams...");
  const input = main.getByLabel("BV号或视频链接", { exact: true });
  await input.fill("not-a-bv");
  await main.getByRole("button", { name: "查找视频", exact: true }).click();
  await expect(main.locator(".bili-panel-error")).toContainText("BV");
  await input.fill("BV1xx411c7mD");
  await main.getByRole("button", { name: "查找视频", exact: true }).click();
  await expect(main.locator(".bili-panel-error")).toContainText("视频");
  await input.fill("https://www.bilibili.com/video/BV17x411w7KC");
  await main.getByRole("button", { name: "查找视频", exact: true }).click();
  await expect(main.locator(".bili-video-info")).toContainText("TouchFish · B站播放演示");
  await openPlayer("video");
  await playing("video");
  await expect.poll(async () => (await media()).video.time).toBeGreaterThan(0.4);
  let value = await media();
  expect(value.video.muted).toBe(true);
  expect(value.audio.muted).toBe(false);
  expect(Math.abs(value.video.time - value.audio.time)).toBeLessThan(0.5);
  expect(value.video.source).toMatch(/^touchfish-media:\/\/stream\//);
  if (floating) {
    console.log("Checking compact/expanded floating transport and independent work accrual...");
    await floatingSize(200, 44);
    await transportIs(true);
    const originalSources = { video: value.video.source, audio: value.audio.source };
    await mediaToggle(true).click();
    await transportIs(false);
    await expect.poll(async () => { const tracks = await media(); return tracks.video.paused && tracks.audio.paused; }).toBe(true);
    const pausedAt = await media();
    await floating.getByRole("button", { name: "展开悬浮窗", exact: true }).click();
    await floatingSize(264, 148);
    const workTime = await floating.locator(".floating-duration").innerText();
    await expect.poll(() => floating.locator(".floating-duration").innerText()).not.toBe(workTime);
    expect(Math.abs((await media()).video.time - pausedAt.video.time)).toBeLessThan(0.12);
    expect(Math.abs((await media()).audio.time - pausedAt.audio.time)).toBeLessThan(0.12);
    expect(await main.evaluate(async (date) => (await window.touchFish.loadData()).records[date].intervals.some(interval => interval.to === null), workDate)).toBe(true);
    await hover();
    await expect(player.getByRole("button", { name: "播放", exact: true })).toBeVisible();
    await mediaToggle(false).click();
    await playing("video");
    await transportIs(true);
    const continued = await media();
    expect(continued.video.time).toBeGreaterThanOrEqual(pausedAt.video.time - 0.1);
    expect({ video: continued.video.source, audio: continued.audio.source }).toEqual(originalSources);
    await floating.getByRole("button", { name: "收起悬浮窗", exact: true }).click();
    await floatingSize(200, 44);
    await floating.screenshot({ path: "docs/floating-media.png", scale: "css" });
    const privacyBoundary = await floating.evaluate(async () => {
      const denied = async callback => { try { await callback(); return false; } catch { return true; } };
      return {
        auth: await denied(() => window.touchFish.bilibili.getAuth()),
        qr: await denied(() => window.touchFish.bilibili.createQr()),
        source: await denied(() => window.touchFish.bilibili.getPlayback()),
        video: await denied(() => window.touchFish.bilibili.getVideo("BV17x411w7KC")),
        play: await denied(() => window.touchFish.bilibili.play({ bvid: "BV17x411w7KC", mode: "video" })),
        mode: await denied(() => window.touchFish.bilibili.setPlayerMode("audio")),
        save: await denied(() => window.touchFish.saveData({})),
        update: await denied(() => window.touchFish.updater.check()),
      };
    });
    expect(privacyBoundary).toEqual({ auth: true, qr: true, source: true, video: true, play: true, mode: true, save: true, update: true });
    const currentTransport = await transport();
    expect(JSON.stringify(currentTransport)).not.toMatch(/touchfish-media|SESSDATA|fixture-only|qrcode_key|title|bvid/);
    await expect(floating.evaluate(async revision => window.touchFish.bilibili.setPlaying("invalid", revision), currentTransport.revision)).rejects.toThrow();
    await expect(floating.evaluate(async revision => window.touchFish.bilibili.setPlaying(false, revision), currentTransport.revision - 1)).rejects.toThrow();
    await floating.evaluate(state => {
      const { open, ...report } = state;
      window.touchFish.bilibili.reportTransportState({ ...report, playing: false, playIntent: false });
    }, currentTransport);
    await player.evaluate(state => {
      const { open, ...report } = state;
      window.touchFish.bilibili.reportTransportState({ ...report, revision: report.revision - 1, playing: false, playIntent: false });
    }, currentTransport);
    await transportIs(true);
    console.log("Checking quick transport intent and cancelling buffered auto-resume...");
    const rapid = await floating.evaluate(async revision => {
      const results = await Promise.allSettled([
        window.touchFish.bilibili.setPlaying(false, revision),
        window.touchFish.bilibili.setPlaying(true, revision),
      ]);
      return results.map(result => result.status);
    }, currentTransport.revision);
    expect(rapid[1]).toBe("fulfilled");
    await playing("video");
    await transportIs(true);
    await player.evaluate(() => document.querySelector("video").dispatchEvent(new Event("waiting")));
    await expect.poll(async () => (await transport()).buffering).toBe(true);
    await expect(mediaToggle(true)).toBeEnabled();
    await mediaToggle(true).click();
    await transportIs(false);
    await player.evaluate(() => {
      document.querySelector("video").dispatchEvent(new Event("canplay"));
      document.querySelector("audio").dispatchEvent(new Event("canplay"));
    });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect((await media()).video.paused).toBe(true);
    expect((await media()).audio.paused).toBe(true);
    await mediaToggle(false).click();
    await playing("video");
    await transportIs(true);
  }
  console.log("Checking stalled network notifications do not pause buffered playback...");
  await expect.poll(async () => { const tracks = await media(); return tracks.video.ready >= 3 && tracks.audio.ready >= 3; }).toBe(true);
  const beforeStalled = await media();
  await player.evaluate(() => {
    document.querySelector("video").dispatchEvent(new Event("stalled"));
    document.querySelector("audio").dispatchEvent(new Event("stalled"));
  });
  await expect.poll(async () => { const tracks = await media(); return !tracks.video.paused && !tracks.audio.paused && tracks.video.time > beforeStalled.video.time + 0.2 && tracks.audio.time > beforeStalled.audio.time + 0.2; }).toBe(true);
  const native = await desktop.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes("window=player"));
    window.setSize(800, 450);
    return { onTop: window.isAlwaysOnTop(), resizable: window.isResizable(), minimum: window.getMinimumSize(), bounds: window.getBounds() };
  });
  expect(native.onTop).toBe(false);
  expect(native.resizable).toBe(true);
  expect(native.minimum).toEqual([320, 180]);
  // Windows converts physical pixels through fractional display scaling.
  expect(Math.abs(native.bounds.width - 800)).toBeLessThanOrEqual(1);
  expect(Math.abs(native.bounds.height - 450)).toBeLessThanOrEqual(1);

  console.log("Checking hover controls, pause, seeking, rate, quality, parts and danmaku...");
  await player.evaluate(() => document.activeElement?.blur());
  await player.mouse.move(-20, -20);
  await expect(player.locator(".bili-player-bottom")).toHaveCSS("opacity", "0");
  await hover();
  await expect(player.locator(".bili-player-bottom")).toHaveCSS("opacity", "1");
  await player.getByRole("button", { name: "暂停播放", exact: true }).click();
  await expect.poll(async () => { const tracks = await media(); return tracks.video.paused && tracks.audio.paused; }).toBe(true);
  await transportIs(false);
  const stoppedTime = (await media()).video.time;
  await new Promise(resolve => setTimeout(resolve, 350));
  expect(Math.abs((await media()).video.time - stoppedTime)).toBeLessThan(0.12);
  await player.getByLabel("播放进度", { exact: true }).fill("5");
  await expect.poll(async () => (await media()).video.time).toBeCloseTo(5, 0);
  await player.getByLabel("播放速度", { exact: true }).selectOption("2");
  value = await media();
  expect(value.video.rate).toBe(2);
  expect(value.audio.rate).toBe(2);
  await player.getByRole("button", { name: "播放", exact: true }).click();
  await playing("video");
  await transportIs(true);
  const beforeQuality = (await media()).video.time;
  const beforeQualityTransport = floating ? await transport() : null;
  await player.getByLabel("清晰度", { exact: true }).selectOption("16");
  await expect.poll(() => player.evaluate(async () => (await window.touchFish.bilibili.getPlayback()).quality)).toBe(16);
  await playing("video");
  expect((await media()).video.time).toBeGreaterThanOrEqual(beforeQuality - 0.3);
  if (floating) {
    await expect.poll(async () => (await transport()).revision).toBeGreaterThan(beforeQualityTransport.revision);
    await expect(floating.evaluate(async revision => window.touchFish.bilibili.setPlaying(false, revision), beforeQualityTransport.revision)).rejects.toThrow();
    await transportIs(true);
  }
  await player.getByLabel("切换分P", { exact: true }).selectOption("102");
  await expect.poll(() => player.evaluate(async () => (await window.touchFish.bilibili.getPlayback()).cid)).toBe(102);
  await playing("video");
  expect((await media()).video.time).toBeLessThan(4);
  const danmakuButton = player.getByRole("button", { name: "打开弹幕", exact: true });
  if (await danmakuButton.count()) await danmakuButton.click();
  await expect(player.getByRole("button", { name: "关闭弹幕", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => desktop.evaluate(() => globalThis.biliFixture.requests.some(request => request.path === "/x/v1/dm/list.so"))).toBe(true);
  await player.getByRole("button", { name: "关闭弹幕", exact: true }).click();
  await expect(player.getByRole("button", { name: "打开弹幕", exact: true })).toHaveAttribute("aria-pressed", "false");
  await hover();
  await player.screenshot({ path: "docs/bilibili-player.png", scale: "css" });

  console.log("Checking audio-only mode, protected payroll IPC and stream failures/retry...");
  const beforeMode = (await media()).video.time;
  await player.getByRole("button", { name: "只听音频", exact: true }).click();
  await playing("audio");
  expect((await media()).audio.time).toBeGreaterThanOrEqual(beforeMode - 0.3);
  expect((await media()).video.paused).toBe(true);
  await player.getByRole("button", { name: "最小化播放器", exact: true }).click();
  const minimized = () => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes("window=player"))?.isMinimized());
  await expect.poll(minimized).toBe(true);
  await player.evaluate(async () => {
    const playback = await window.touchFish.bilibili.getPlayback();
    await window.touchFish.bilibili.play({ bvid: playback.video.bvid, mode: playback.mode, cid: playback.cid, quality: 16 });
  });
  await playing("audio");
  expect(await minimized()).toBe(true);
  const minimizedTime = (await media()).audio.time;
  await expect.poll(async () => (await media()).audio.time).toBeGreaterThan(minimizedTime + 0.2);
  if (floating) {
    console.log("Checking minimized audio transport does not reveal or reload the player...");
    await transportIs(true);
    await mediaToggle(true).click();
    await transportIs(false);
    await expect.poll(async () => (await media()).audio.paused).toBe(true);
    const audioPaused = await media();
    expect(await minimized()).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(Math.abs((await media()).audio.time - audioPaused.audio.time)).toBeLessThan(0.12);
    await mediaToggle(false).click();
    await playing("audio");
    await transportIs(true);
    expect(await minimized()).toBe(true);
    const resumed = await media();
    expect(resumed.audio.source).toBe(audioPaused.audio.source);
    expect(resumed.audio.rate).toBe(audioPaused.audio.rate);
    expect(resumed.audio.time).toBeGreaterThanOrEqual(audioPaused.audio.time - 0.1);
    expect(resumed.video.source).toBe(null);
  }
  await main.evaluate(() => window.touchFish.bilibili.showPlayer());
  await expect.poll(minimized).toBe(false);
  await hover();
  expect(await player.evaluate(async () => {
    const denied = async callback => { try { await callback(); return false; } catch { return true; } };
    return { save: await denied(() => window.touchFish.saveData({})), update: await denied(() => window.touchFish.updater.check()) };
  })).toEqual({ save: true, update: true });
  await player.getByRole("button", { name: "切换到视频", exact: true }).click();
  await playing("video");
  if (floating) {
    console.log("Checking ended playback restarts from the floating button without loading a new stream...");
    await hover();
    const streamRequests = await desktop.evaluate(() => globalThis.biliFixture.requests.filter(request => request.path === "/x/player/wbi/playurl").length);
    const sources = await media();
    await player.getByLabel("播放进度", { exact: true }).fill("19.6");
    await expect.poll(async () => (await transport()).ended, { timeout: 10000 }).toBe(true);
    await transportIs(false);
    await mediaToggle(false).click();
    await playing("video");
    await transportIs(true);
    const replayed = await media();
    expect(replayed.video.time).toBeLessThan(3);
    expect(replayed.audio.time).toBeLessThan(3);
    expect(replayed.video.source).toBe(sources.video.source);
    expect(replayed.audio.source).toBe(sources.audio.source);
    expect(await desktop.evaluate(() => globalThis.biliFixture.requests.filter(request => request.path === "/x/player/wbi/playurl").length)).toBe(streamRequests);
    await hover();
  }
  await closePlayer();
  await fixture("setMedia", "forbidden");
  await openPlayer("video");
  await expect(player.locator(".bili-player-error")).toBeVisible({ timeout: 20000 });
  if (floating) {
    await expect.poll(async () => (await transport()).failed).toBe(true);
    await expect(floating.locator(".floating-media-toggle")).toBeDisabled();
  }
  await fixture("setMedia", "good");
  await player.getByRole("button", { name: "重试播放", exact: true }).click();
  await playing("video");
  await transportIs(true);
  await hover();
  await closePlayer();
  await main.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(main.getByRole("button", { name: "获取二维码", exact: true })).toBeVisible();
  expect(await desktop.evaluate(async ({ session }) => (await session.fromPartition("persist:touchfish-bilibili").cookies.get({ domain: "bilibili.com" })).length)).toBe(0);
  const requests = await desktop.evaluate(() => globalThis.biliFixture.requests);
  const cdn = requests.filter(request => request.host === "upos-fixture.bilivideo.com");
  expect(cdn.some(request => request.range)).toBe(true);
  expect(cdn.every(request => request.referer === "https://www.bilibili.com/" && !request.hasCookie)).toBe(true);
  expect(errors).toEqual([]);
  console.log("PASS: QR login states/persistence/logout, BV lookup, decoded split playback, range/referrer, buffered stalled events, resize/non-topmost window, hover controls, pause/seek/rate/quality/parts, danmaku, floating transport/state/source isolation, independent wage timer, ended replay, audio-only/minimized playback, protected IPC and media failure recovery.");
  console.log(`Isolated data: ${userData}`);
} finally {
  await close();
}

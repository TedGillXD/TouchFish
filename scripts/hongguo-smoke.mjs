import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { seedHolidayCache } from "./test-holiday-cache.mjs";

const origin = "https://hongguoduanju.com";
const episode = `${origin}/player/7706512650816982040`;
const partition = "persist:touchfish-hongguo";
const cookieName = "touchfish-hongguo-fixture";

// Register a private-session protocol fixture before the app initializes. All
// site requests stay in Electron, and neither real credentials nor TLS options
// are touched. The cookie imitates the official site's successful login state.
await mkdir(".cache", { recursive: true });
const directory = await mkdtemp(resolve(".cache/hongguo-ui-"));
const userData = join(directory, "user-data");
await mkdir(userData, { recursive: true });
await seedHolidayCache(userData);
const harnessPath = join(directory, "hongguo-harness.cjs");
const html = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><title>红果离线验证</title>
<body>
  <h1>红果离线验证</h1>
  <button id="login">扫码登录测试</button><output id="account"></output>
  <video width="320" height="180" src="/fixture.webm" loop playsinline></video>
  <button id="play">播放测试视频</button>
  <button id="fullscreen">视频全屏测试</button>
  <a href="https://example.invalid/hongguo-blocked">不受信页面</a>
  <a href="https://example.invalid/hongguo-popup" target="_blank">不受信弹窗</a>
  <a href="/fixture-redirect">重定向测试</a>
  <script>
    const updateAccount = () => {
      const cookie = document.cookie.split('; ').includes('${cookieName}=signed-in');
      const storage = localStorage.getItem('hongguo-fixture') === 'signed-in';
      document.querySelector('#account').textContent = cookie && storage ? '已登录测试账号' : '访客模式';
    };
    document.querySelector('#login').addEventListener('click', () => {
      document.cookie = '${cookieName}=signed-in; Max-Age=3600; Path=/; SameSite=Lax; Secure';
      localStorage.setItem('hongguo-fixture', 'signed-in');
      updateAccount();
    });
    document.querySelector('#play').addEventListener('click', () => document.querySelector('video').play().catch(() => {}));
    document.querySelector('#fullscreen').addEventListener('click', event => {
      document.querySelector('video').requestFullscreen().catch(error => { event.target.dataset.error = error.message; });
    });
    updateAccount();
  </script>
</body></html>`;

await writeFile(harnessPath, `
const { app, session } = require('electron');
const { readFileSync } = require('node:fs');
const requests = [];
globalThis.hongguoFixtureRequests = requests;
app.setPath('userData', process.env.TOUCHFISH_USER_DATA);
const video = readFileSync(${JSON.stringify(resolve("tests/fixtures/bili-video.webm"))});
const html = ${JSON.stringify(html)};
const ready = app.whenReady().then(async () => {
  const profile = session.fromPartition(${JSON.stringify(partition)});
  await profile.protocol.handle('https', request => {
    const { origin, pathname } = new URL(request.url);
    requests.push({ origin, pathname });
    if (origin !== ${JSON.stringify(origin)}) return new Response('Unexpected origin', { status: 403 });
    if (pathname === '/fixture-redirect') return Response.redirect('https://example.invalid/hongguo-redirect');
    if (pathname === '/fixture.webm') {
      const range = /^bytes=(\\d+)-(\\d*)$/.exec(request.headers.get('range') || '');
      const start = range ? Number(range[1]) : 0;
      const end = range && range[2] ? Math.min(video.length - 1, Number(range[2])) : video.length - 1;
      if (start > end) return new Response('', { status: 416, headers: { 'Content-Range': 'bytes */' + video.length } });
      const headers = { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) };
      if (range) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + video.length;
      return new Response(video.subarray(start, end + 1), { status: range ? 206 : 200, headers });
    }
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  });
});
app.whenReady = () => ready;
require(${JSON.stringify(resolve("dist-electron/main.cjs"))});
`, "utf8");

const env = { ...process.env, TOUCHFISH_USER_DATA: userData, TOUCHFISH_KEEP_OPEN: "1", TOUCHFISH_HOLIDAYS_AUTO_REFRESH: "0" };
delete env.ELECTRON_RUN_AS_NODE;
// Electron may expose its separate WebContentsView as a DevTools "other"
// target. Attach to that target as well as the local BrowserWindow page.
process.env.PW_CHROMIUM_ATTACH_TO_OTHER = "1";
const fixtureErrors = [];
let desktop, main, chrome, player;

async function launch() {
  desktop = await electron.launch({ executablePath: electronPath, args: [harnessPath], env });
  await expect.poll(() => desktop.windows().some(page => page.url().endsWith("/index.html")), { timeout: 15000 }).toBe(true);
  main = desktop.windows().find(page => page.url().endsWith("/index.html"));
  main.setDefaultTimeout(15000);
  main.on("pageerror", error => fixtureErrors.push(error.message));
  await main.getByRole("button", { name: "摸鱼", exact: true }).click();
  await main.getByRole("tab", { name: "红果短剧", exact: true }).click();
}

async function selectPlayer() {
  await expect.poll(() => desktop.windows().some(page => page.url().includes("window=hongguo-chrome"))).toBe(true);
  chrome = desktop.windows().find(page => page.url().includes("window=hongguo-chrome"));
  chrome.setDefaultTimeout(15000);
  chrome.on("pageerror", error => fixtureErrors.push(error.message));
  await expect(chrome.locator('[aria-label="红果短剧小窗控制"]')).toBeVisible();
  await expect.poll(() => desktop.windows().some(page => page.url().startsWith(`${origin}/`)), { timeout: 15000 }).toBe(true);
  player = desktop.windows().find(page => page.url().startsWith(`${origin}/`));
  player.setDefaultTimeout(15000);
  player.on("pageerror", error => fixtureErrors.push(error.message));
  await expect(player.getByRole("heading", { name: "红果离线验证" })).toBeVisible();
}

async function openPlayer() {
  await main.getByRole("button", { name: "打开红果小窗", exact: true }).click();
  await selectPlayer();
}

async function closePlayer() {
  const closed = player.waitForEvent("close", { timeout: 10000 });
  await chrome.getByRole("button", { name: "关闭窗口", exact: true }).click({ noWaitAfter: true })
    .catch(error => { if (!chrome.isClosed()) throw error; });
  await closed;
  await expect.poll(async () => (await state()).open).toBe(false);
}

async function quitNormally() {
  const closed = desktop.waitForEvent("close", { timeout: 15000 });
  await main.evaluate(() => window.touchFish.quit());
  await closed;
  await desktop.close().catch(() => {});
  desktop = undefined;
}

const state = () => main.evaluate(() => window.touchFish.hongguo.getState());
const nativeState = () => desktop.evaluate(({ BrowserWindow }, origin) => {
  const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes("window=hongguo-chrome"));
  const child = window?.contentView.children.find(view => view.webContents?.getURL().startsWith(`${origin}/`));
  if (!window || !child) return null;
  return { visible: window.isVisible(), minimized: window.isMinimized(), fullscreen: window.isFullScreen(),
    muted: child.webContents.isAudioMuted(), outer: window.getBounds(), content: window.getContentBounds(), child: child.getBounds() };
}, origin);
const mediaState = () => player.locator("video").evaluate(element => ({
  paused: element.paused, currentTime: element.currentTime, ready: element.readyState,
}));

async function play() {
  await player.getByRole("button", { name: "播放测试视频", exact: true }).click();
  await expect.poll(async () => {
    const media = await mediaState();
    return media.ready >= 2 && !media.paused && media.currentTime > 0.1;
  }).toBe(true);
}

async function expectStationaryMedia() {
  await expect.poll(async () => (await mediaState()).paused).toBe(true);
  const position = (await mediaState()).currentTime;
  await new Promise(resolve => setTimeout(resolve, 250));
  const current = await mediaState();
  expect(current.paused).toBe(true);
  expect(Math.abs(current.currentTime - position)).toBeLessThan(0.03);
}

async function retryPlaybackWithoutInput() {
  await player.locator("video").evaluate(element => { void element.play().catch(() => {}); });
  await expectStationaryMedia();
}

try {
  console.log("Checking official-window entry point and isolated web session...");
  await launch();
  expect(await state()).toMatchObject({ open: false, concealed: false });
  await openPlayer();
  await expect(main.getByRole("button", { name: "显示红果小窗", exact: true })).toBeVisible();
  expect(await player.evaluate(() => ({ touchFish: typeof window.touchFish, toolbar: typeof window.hongguoWindow, require: typeof window.require })))
    .toEqual({ touchFish: "undefined", toolbar: "undefined", require: "undefined" });
  expect(await chrome.evaluate(() => ({ touchFish: typeof window.touchFish, toolbar: typeof window.hongguoWindow })))
    .toEqual({ touchFish: "undefined", toolbar: "object" });

  console.log("Checking the frameless host, child view resizing and in-window fullscreen...");
  const normal = await nativeState();
  expect(normal.child).toMatchObject({ x: 0, y: 36, width: normal.content.width, height: normal.content.height - 36 });
  if (process.platform === "win32") expect(Math.abs(normal.content.y - normal.outer.y)).toBeLessThan(16);
  await desktop.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes("window=hongguo-chrome"));
    const [width, height] = window.getSize();
    const [minWidth] = window.getMinimumSize();
    window.setSize(width - 64 >= minWidth ? width - 64 : width + 64, height);
  });
  await expect.poll(async () => {
    const { child, content } = await nativeState();
    return child.width !== normal.child.width && child.width === content.width && child.height === content.height - 36;
  }).toBe(true);
  const resized = await nativeState();
  await player.getByRole("button", { name: "视频全屏测试", exact: true }).click();
  await expect.poll(() => player.evaluate(() => {
    const video = document.fullscreenElement;
    const bounds = video?.getBoundingClientRect();
    return {
      videoFullscreen: video instanceof HTMLVideoElement,
      fillsViewport: !!bounds && Math.abs(bounds.width - innerWidth) <= 1 && Math.abs(bounds.height - innerHeight) <= 1,
      error: document.querySelector('#fullscreen').dataset.error ?? null,
    };
  })).toEqual({ videoFullscreen: true, fillsViewport: true, error: null });
  expect(await nativeState()).toMatchObject({ fullscreen: false, outer: resized.outer, child: resized.child });
  await player.evaluate(() => document.exitFullscreen());
  await expect.poll(() => player.evaluate(() => document.fullscreenElement === null)).toBe(true);

  await chrome.getByRole("button", { name: "最小化窗口", exact: true }).click();
  await expect.poll(async () => (await nativeState())?.minimized).toBe(true);
  await main.getByRole("button", { name: "显示红果小窗", exact: true }).click();
  await expect.poll(async () => (await nativeState())?.minimized).toBe(false);
  await expect(player.getByText("访客模式", { exact: true })).toBeVisible();
  await player.getByRole("button", { name: "扫码登录测试", exact: true }).click();
  await expect(player.getByText("已登录测试账号", { exact: true })).toBeVisible();
  expect(await desktop.evaluate(async ({ session }, { origin, partition, name }) => {
    const filter = { url: origin, name };
    const dedicated = await session.fromPartition(partition).cookies.get(filter);
    const defaultSession = await session.defaultSession.cookies.get(filter);
    return { dedicated: dedicated.length, defaultSession: defaultSession.length };
  }, { origin, partition, name: cookieName })).toEqual({ dedicated: 1, defaultSession: 0 });

  console.log("Checking native hide, actual media pause and user-controlled resume...");
  await play();
  await expect.poll(async () => (await nativeState())?.visible).toBe(true);
  await main.evaluate(() => window.touchFish.bossKey.trigger());
  expect(await state()).toMatchObject({ open: true, visible: false, concealed: true });
  expect(await nativeState()).toMatchObject({ visible: false, muted: true });
  await expectStationaryMedia();
  await retryPlaybackWithoutInput();
  expect(await main.evaluate(async () => {
    try { await window.touchFish.hongguo.open(); return false; } catch { return true; }
  })).toBe(true);

  await main.evaluate(() => window.touchFish.bossKey.restore());
  await expect.poll(async () => (await nativeState())?.visible).toBe(true);
  expect(await state()).toMatchObject({ open: true, visible: true, concealed: false });
  await expectStationaryMedia();
  await retryPlaybackWithoutInput();
  await play();
  await expect.poll(async () => (await nativeState())?.muted).toBe(false);

  console.log("Checking official-link navigation and blocking foreign destinations...");
  for (const input of ["http://hongguoduanju.com/", "https://hongguoduanju.com.example.invalid/", "https://fixture@hongguoduanju.com/", "javascript:void(0)"]) {
    expect(await main.evaluate(async input => {
      try { await window.touchFish.hongguo.open(input); return false; } catch { return true; }
    }, input)).toBe(true);
  }
  const nativeWindows = () => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const windows = await nativeWindows();
  const url = player.url();
  // Chromium cancels these before document commit, but Playwright retains a
  // pending navigation signal and blocks subsequent locator actions. Exercise
  // link activation in the page and assert against the request and window log.
  for (const name of ["不受信页面", "不受信弹窗", "重定向测试"]) {
    await player.evaluate(name => {
      const link = [...document.links].find(link => link.textContent === name);
      if (!link) throw new Error("Missing fixture link: " + name);
      link.click();
    }, name);
  }
  await expect.poll(() => desktop.evaluate(() => globalThis.hongguoFixtureRequests.some(request => request.pathname === "/fixture-redirect"))).toBe(true);
  expect(await nativeWindows()).toBe(windows);
  expect(player.url()).toBe(url);
  expect(await desktop.evaluate((_electron, origin) => globalThis.hongguoFixtureRequests.every(request => request.origin === origin), origin)).toBe(true);
  await main.getByRole("textbox", { name: "红果短剧链接", exact: true }).fill(episode);
  await main.getByRole("button", { name: "打开剧集", exact: true }).click();
  await expect(player).toHaveURL(episode);
  await expect(player.getByText("已登录测试账号", { exact: true })).toBeVisible();

  console.log("Checking account state after closing the window and restarting the app...");
  await closePlayer();
  await openPlayer();
  await expect(player.getByText("已登录测试账号", { exact: true })).toBeVisible();
  await quitNormally();
  await launch();
  await openPlayer();
  await expect(player.getByText("已登录测试账号", { exact: true })).toBeVisible();
  expect(fixtureErrors).toEqual([]);
  await quitNormally();
  console.log("PASS: frameless Red Fruit controls, child viewport resize/fullscreen, isolated persistent web session, navigation restrictions, boss-key pause/hide and paused restore.");
} finally {
  if (desktop) {
    await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {});
    await desktop.close().catch(() => {});
  }
}

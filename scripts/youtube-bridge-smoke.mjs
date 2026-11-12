import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { build } from "esbuild";
import { WebSocket } from "ws";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";

await mkdir(".cache", { recursive: true });
const directory = await mkdtemp(resolve(".cache/youtube-bridge-"));
const harness = join(directory, "harness.cjs");
await build({
  stdin: { contents: `
import {app,BrowserWindow} from 'electron';
import {createYouTubeWindow} from './electron/youtube-window';
import {YOUTUBE_EXTENSION_ORIGIN,YOUTUBE_BRIDGE_PROTOCOL} from './electron/youtube-policy';
app.setPath('userData',process.env.TOUCHFISH_USER_DATA);
app.whenReady().then(async()=>{
 const launches=[],states=[],transports=[];let service;
 const create=()=>createYouTubeWindow({extensionDirectory:${JSON.stringify(resolve("extensions/youtube-companion"))},onState:value=>states.push(value),onTransportState:value=>transports.push(value),openBrowser:async(url,browser)=>{launches.push({url,browser});}});
 const recreate=async()=>{service?.dispose();service=await create();};await recreate();
 globalThis.youtubeFixture={get service(){return service;},launches,states,transports,recreate,origin:YOUTUBE_EXTENSION_ORIGIN,protocol:YOUTUBE_BRIDGE_PROTOCOL};
 const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await window.loadURL('about:blank');
}).catch(error=>{console.error(error.message);app.exit(1);});
`, resolveDir: resolve("."), sourcefile: "youtube-bridge-fixture.ts", loader: "ts" },
  outfile: harness, bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron", "ws"],
});
const env = { ...process.env, TOUCHFISH_USER_DATA: join(directory, "user-data") };
delete env.ELECTRON_RUN_AS_NODE;
let desktop, connection;
const commands = [];
let mediaState = { open: false };
let holdOpen = false, heldOpen = null, conceal = false;
const call = (operation, args = []) => desktop.evaluate(async (_electron, { operation, args }) => {
  const fixture = globalThis.youtubeFixture;
  if (operation === "info") return { origin: fixture.origin, protocol: fixture.protocol, launches: fixture.launches };
  if (operation === "recreate") return fixture.recreate();
  return fixture.service[operation](...args);
}, { operation, args });

async function pair() {
  await call("connectBrowser", ["chrome"]);
  const info = await call("info");
  const url = info.launches.at(-1).url;
  const denied = await fetch(url, { headers: { Origin: "https://evil.invalid" } });
  expect(denied.status).toBe(403);
  const response = await fetch(url);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  const html = await response.text();
  const config = JSON.parse(/<script type="application\/json" id="config">([^<]+)<\/script>/.exec(html)?.[1] || "null");
  expect(config.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/bridge$/);
  expect(config.token).toMatch(/^[a-f0-9]{48}$/);
  expect((await fetch(url)).status).toBe(410);
  return { ...info, ...config };
}
async function rejectsSocket(config, patch = {}) {
  const origin = "origin" in patch ? patch.origin : config.origin;
  const protocols = patch.protocols || [config.protocol, patch.token || config.token];
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(patch.url || config.url, protocols, origin ? { origin } : {});
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("Rejected socket did not finish")); }, 3000);
    socket.on("error", () => {});
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timer); socket.terminate();
      try { expect(response.statusCode).toBe(403); resolve(); } catch (error) { reject(error); }
    });
    socket.once("open", () => { clearTimeout(timer); socket.close(); reject(new Error("Untrusted client was accepted")); });
  });
}
function respond(message, result) {
  if (connection?.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: { state: result } }));
}
async function connect(config) {
  connection = new WebSocket(config.url, [config.protocol, config.token], { origin: config.origin });
  connection.on("error", () => {});
  connection.on("message", bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.type !== "command") return;
    commands.push(message);
    if (message.action === "open") {
      if (holdOpen) { heldOpen = message; return; }
      mediaState = { open: true, ready: true, playing: true, playIntent: true, buffering: false, ended: false, failed: false,
        sourceId: "fixture-source-1", videoId: "aqz-KE-bpKQ", title: "Original fixture", visible: true, minimized: false };
    } else if (message.action === "setPlaying") {
      mediaState = { ...mediaState, playing: message.args.playing && !conceal, playIntent: message.args.playing && !conceal };
    } else if (message.action === "pauseAndMinimize") {
      conceal = true; mediaState = { ...mediaState, playing: false, playIntent: false, visible: false, minimized: true };
    } else if (message.action === "restorePaused") {
      conceal = false; mediaState = { ...mediaState, playing: false, playIntent: false, visible: true, minimized: false };
    } else if (message.action === "close") mediaState = { open: false };
    respond(message, mediaState);
  });
  await new Promise((resolve, reject) => { connection.once("open", resolve); connection.once("error", reject); });
  connection.send(JSON.stringify({ type: "hello", version: 1, browser: "chrome" }));
  await expect.poll(async () => (await call("getState")).connected).toBe(true);
}

try {
  desktop = await electron.launch({ executablePath: electronPath, args: [harness], env });
  await desktop.firstWindow();
  console.log("Checking single-use browser pairing and authenticated loopback handshake...");
  const config = await pair();
  await rejectsSocket(config, { origin: "https://evil.invalid" });
  await rejectsSocket(config, { origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
  await rejectsSocket(config, { origin: undefined });
  await rejectsSocket(config, { token: "0".repeat(48) });
  await rejectsSocket(config, { url: config.url.replace("/bridge", "/other") });
  await rejectsSocket(config, { protocols: [config.protocol, config.token, "extra"] });
  await connect(config);

  console.log("Checking narrow playback state, controls, boss concealment and stale responses...");
  const opened = await call("open", ["https://youtu.be/aqz-KE-bpKQ"]);
  expect(opened.open).toBe(true);
  let transport = await call("getTransportState");
  expect(transport.playIntent).toBe(true);
  expect((await call("setPlaying", [false, transport.revision])).playIntent).toBe(false);
  await call("setVolume", [0.4]);
  await call("setPlaybackRate", [1.5]);
  await expect(call("setVolume", [2])).rejects.toThrow();
  await expect(call("setPlaybackRate", [20])).rejects.toThrow();
  expect(commands.some(command => command.action === "setVolume" && command.args.volume === 0.4)).toBe(true);
  await call("pauseAndHide");
  expect((await call("getState")).concealed).toBe(true);
  expect((await call("getTransportState")).playIntent).toBe(false);
  await expect(call("setPlaying", [true, transport.revision])).rejects.toThrow();
  await expect(call("open", ["aqz-KE-bpKQ"])).rejects.toThrow();
  connection.send(JSON.stringify({ type: "state", state: { ...mediaState, playing: true, playIntent: true, visible: true, minimized: false } }));
  await new Promise(resolve => setTimeout(resolve, 50));
  expect((await call("getState")).visible).toBe(false);
  expect((await call("getTransportState")).playIntent).toBe(false);
  await call("restorePaused");
  await expect.poll(async () => (await call("getState")).visible).toBe(true);
  expect((await call("getTransportState")).playIntent).toBe(false);

  holdOpen = true;
  const pendingOpen = call("open", ["aqz-KE-bpKQ"]).then(() => false, () => true);
  await expect.poll(() => !!heldOpen).toBe(true);
  await call("pauseAndHide");
  respond(heldOpen, { ...mediaState, playing: true, playIntent: true, visible: true, minimized: false });
  expect(await pendingOpen).toBe(true);
  expect((await call("getState")).visible).toBe(false);
  expect((await call("getTransportState")).playIntent).toBe(false);
  holdOpen = false; heldOpen = null;

  console.log("Checking old-instance credentials and disconnected concealment...");
  connection.close();
  await expect.poll(async () => (await call("getState")).connected).toBe(false);
  await call("pauseAndHide");
  await call("recreate");
  const next = await pair();
  expect(next.token).not.toBe(config.token);
  await rejectsSocket(next, { token: config.token });
  console.log("PASS: single-use pairing, exact extension origin and nonce, loopback socket scope, media-only commands, boss concealment, stale response guards, and old-instance rejection.");
} finally {
  connection?.close();
  await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await desktop?.close().catch(() => {});
}

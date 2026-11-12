import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const directory = new URL("../extensions/youtube-companion/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", directory), "utf8"));
const background = await readFile(new URL("background.js", directory), "utf8");
const policy = await readFile(new URL("../electron/youtube-policy.ts", import.meta.url), "utf8");
const extensionId = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex")
  .slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
const fixtureId = "aqz-KE-bpKQ";
const token = "a".repeat(48);
const pairUrl = "http://127.0.0.1:43891/pair";
const bridgeUrl = "ws://127.0.0.1:43891/bridge";
const clone = value => structuredClone(value);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const event = () => ({ listeners: [], addListener(listener) { this.listeners.push(listener); }, emit(...args) { for (const listener of this.listeners) listener(...args); } });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(condition, message) {
  const end = Date.now() + 2000;
  while (!condition()) { if (Date.now() > end) throw new Error(message); await tick(); }
}

function createFixture() {
  const windows = new Map(), tabs = new Map(), records = [], sockets = [], pending = new Map();
  let nextWindow = 10, nextTab = 100, commandId = 0, createGate = null, holdGate = null, playGate = null, attachGate = null;
  const storage = {};
  const runtime = { id: extensionId, getURL: path => `chrome-extension://${extensionId}/${path}`, onMessageExternal: event(), onMessage: event() };
  const chrome = {
    runtime,
    storage: { session: { async get(keys) { return Object.fromEntries(keys.filter(key => key in storage).map(key => [key, clone(storage[key])])); }, async set(value) { Object.assign(storage, clone(value)); } } },
    windows: {
      onRemoved: event(), onBoundsChanged: event(),
      async get(id) { const value = windows.get(id); if (!value) throw new Error("No window"); return { ...clone(value), tabs: value.tabs.map(tab => clone(tabs.get(tab))) }; },
      async create(options) {
        records.push({ api: "windows.create", options: clone(options) });
        if (createGate) { const gate = createGate; createGate = null; gate.entered = true; await gate.promise; }
        const id = nextWindow++, tabId = nextTab++;
        const tab = { id: tabId, windowId: id, url: options.url, mutedInfo: { muted: false } };
        tabs.set(tabId, tab); windows.set(id, { id, state: options.state ?? "normal", tabs: [tabId] });
        return { id, state: windows.get(id).state, tabs: [clone(tab)] };
      },
      async update(id, options) {
        records.push({ api: "windows.update", id, options: clone(options) });
        const value = windows.get(id); if (!value) throw new Error("No window"); Object.assign(value, options);
        return { ...clone(value), tabs: value.tabs.map(tab => clone(tabs.get(tab))) };
      },
      async remove(id) {
        records.push({ api: "windows.remove", id });
        const value = windows.get(id); windows.delete(id);
        for (const tab of value?.tabs ?? []) { tabs.delete(tab); chrome.tabs.onRemoved.emit(tab); }
        chrome.windows.onRemoved.emit(id);
      },
    },
    tabs: {
      onCreated: event(), onRemoved: event(), onUpdated: event(),
      async get(id) { if (!tabs.has(id)) throw new Error("No tab"); return clone(tabs.get(id)); },
      async remove(id) { records.push({ api: "tabs.remove", id }); const tab = tabs.get(id); tabs.delete(id); if (tab && windows.has(tab.windowId)) windows.get(tab.windowId).tabs = windows.get(tab.windowId).tabs.filter(value => value !== id); chrome.tabs.onRemoved.emit(id); },
      async update(id, options) {
        records.push({ api: "tabs.update", id, options: clone(options) });
        const value = tabs.get(id); if (!value) throw new Error("No tab");
        if ("muted" in options) value.mutedInfo.muted = options.muted;
        if ("url" in options) { value.url = options.url; chrome.tabs.onUpdated.emit(id, { url: options.url }, clone(value)); }
        return clone(value);
      },
      async sendMessage(id, message) {
        records.push({ api: "tabs.sendMessage", id, message: clone(message) });
        if (!tabs.has(id)) throw new Error("No tab");
        if (message.action === "hold" && holdGate) { const gate = holdGate; holdGate = null; gate.entered = true; await gate.promise; }
        if (message.action === "setPlaying" && playGate) { const gate = playGate; playGate = null; gate.entered = true; await gate.promise; }
        if (message.action === "attach" && attachGate) { const gate = attachGate; attachGate = null; gate.entered = true; await gate.promise; }
        return { videoId: fixtureId, title: "Original test fixture", ready: true, playing: message.action === "setPlaying" && message.playing === true,
          playIntent: message.action === "setPlaying" && message.playing === true, buffering: false, ended: false, failed: false, currentTime: 1, duration: 20 };
      },
    },
  };
  class Socket {
    static OPEN = 1;
    constructor(url, protocols) { this.url = url; this.protocols = protocols; this.readyState = 0; this.sent = []; sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
    send(bytes) {
      const value = JSON.parse(bytes); this.sent.push(value); records.push({ api: "socket.send", value });
      if (value.type === "response") { const done = pending.get(value.id); pending.delete(value.id); if (value.ok) done?.resolve(value.result); else done?.reject(new Error("Extension rejected command")); }
    }
    close(code, reason) { this.readyState = 3; this.onclose?.({ code, reason }); }
    receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  }
  const timeout = (fn, duration, ...args) => { records.push({ api: "setTimeout", duration }); const timer = setTimeout(fn, duration, ...args); timer.unref(); return timer; };
  const interval = (fn, duration, ...args) => { const timer = setInterval(fn, duration, ...args); timer.unref(); return timer; };
  vm.runInNewContext(background, { chrome, WebSocket: Socket, URL, navigator: { userAgent: "Chrome/130.0" }, console,
    setTimeout: timeout, clearTimeout, setInterval: interval, clearInterval, queueMicrotask }, { filename: "youtube-companion/background.js" });
  const external = (message, sender = { url: pairUrl }) => new Promise(resolve => {
    const keep = runtime.onMessageExternal.listeners[0](message, sender, resolve);
    if (!keep) resolve({ ok: false });
  });
  return {
    chrome, records, sockets, storage, windows, tabs, external,
    async pair() { assert.equal((await external({ type: "touchfish-pair", url: bridgeUrl, token })).ok, true); await until(() => sockets.at(-1)?.readyState === 1, "Socket did not open"); },
    command(action, args = {}) { const id = ++commandId; const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject })); sockets.at(-1).receive({ type: "command", id, action, args }); return promise; },
    media(tabId, overrides = {}, sender = {}) {
      runtime.onMessage.emit({ type: "touchfish-media", state: { ready: true, videoId: fixtureId, playing: true, playIntent: true, title: "Original test fixture", ...overrides } },
        { id: extensionId, frameId: 0, tab: { id: tabId }, documentId: "document1", ...sender }, () => {});
    },
    hello(tabId, sender = {}) { return new Promise(resolve => runtime.onMessage.emit({ type: "touchfish-hello" }, { id: extensionId, frameId: 0, tab: { id: tabId }, ...sender }, value => resolve(clone(value)))); },
    delayCreate() { createGate = { ...deferred(), entered: false }; return createGate; },
    delayHold() { holdGate = { ...deferred(), entered: false }; return holdGate; },
    delayPlay() { playGate = { ...deferred(), entered: false }; return playGate; },
    delayAttach() { attachGate = { ...deferred(), entered: false }; return attachGate; },
    addUnmanaged(windowId = 501, tabId = 601) { tabs.set(tabId, { id: tabId, windowId, url: "https://accounts.google.com/", mutedInfo: { muted: false } }); windows.set(windowId, { id: windowId, state: "normal", tabs: [tabId] }); return { windowId, tabId }; },
  };
}

console.log("Checking extension identity, official-site scope, and pairing sender validation...");
assert.match(policy, new RegExp(`YOUTUBE_EXTENSION_ID = "${extensionId}"`));
assert.deepEqual(manifest.permissions, ["storage"]);
assert.deepEqual(manifest.host_permissions, ["https://www.youtube.com/*", "http://127.0.0.1/*"]);
assert.deepEqual(manifest.content_scripts.map(script => script.matches), [["https://www.youtube.com/*"]]);
assert.equal(manifest.content_scripts[0].all_frames, false);
assert.deepEqual(manifest.externally_connectable.matches, ["http://127.0.0.1/*"]);
const f = createFixture();
for (const [senderUrl, destination, secret] of [
  ["https://accounts.google.com/pair", bridgeUrl, token], ["http://localhost:43891/pair", bridgeUrl, token],
  ["http://user:password@127.0.0.1:43891/pair", bridgeUrl, token],
  ["http://127.0.0.1:43891/other", bridgeUrl, token], [pairUrl, "ws://127.0.0.1:43892/bridge", token],
  [pairUrl, `${bridgeUrl}?evil=1`, token], [pairUrl, bridgeUrl, "bad"],
]) assert.equal((await f.external({ type: "touchfish-pair", url: destination, token: secret }, { url: senderUrl })).ok, false);
assert.equal(f.sockets.length, 0);
await f.pair();
assert.deepEqual(Array.from(f.sockets[0].protocols), ["touchfish-youtube-v1", token]);
assert.equal(Object.keys(f.storage).includes("touchfishConnection"), true);

const pairingTab = createFixture();
const local = pairingTab.addUnmanaged(); pairingTab.tabs.get(local.tabId).url = pairUrl;
assert.equal((await pairingTab.external({ type: "touchfish-pair", url: bridgeUrl, token }, { url: pairUrl, tab: { id: local.tabId } })).ok, true);
await until(() => !pairingTab.tabs.has(local.tabId), "Validated local pairing tab was not closed");
assert.equal(pairingTab.windows.has(local.windowId), true);
assert.deepEqual(pairingTab.records.filter(record => record.api === "tabs.remove").map(record => record.id), [local.tabId]);
for (const currentUrl of ["https://example.org/work", "http://127.0.0.1:43891/other", "http://127.0.0.1:43892/pair"]) {
  const changed = createFixture(), work = changed.addUnmanaged(); changed.tabs.get(work.tabId).url = currentUrl;
  await changed.external({ type: "touchfish-pair", url: bridgeUrl, token }, { url: pairUrl, tab: { id: work.tabId } });
  await tick(); assert.equal(changed.tabs.has(work.tabId), true); assert.equal(changed.records.some(record => record.api === "tabs.remove"), false);
}

console.log("Checking managed windows, native mute, paused restore, and mixed work windows...");
const work = f.addUnmanaged();
await f.command("open", { url: `https://www.youtube.com/watch?v=${fixtureId}` });
const primary = [...f.tabs.values()].find(tab => tab.id !== work.tabId);
assert.equal(f.windows.get(primary.windowId).state, "normal");
assert.equal(f.records.find(record => record.api === "windows.create").options.url, `chrome-extension://${extensionId}/launch.html`);
assert.equal((await f.hello(primary.id)).managed, true);
assert.equal((await f.hello(work.tabId)).managed, false);
assert.equal((await f.hello(primary.id, { id: "another-extension" })).managed, false);
assert.equal((await f.hello(primary.id, { frameId: 1 })).managed, false);
f.media(primary.id);
await tick();
const sourceId = (await f.command("getState")).state.sourceId;
assert.equal((await f.command("getState")).state.playing, true);
await f.command("pauseAndMinimize");
assert.equal(f.windows.get(primary.windowId).state, "minimized");
assert.equal(f.tabs.get(primary.id).mutedInfo.muted, true);
assert.equal(f.windows.get(work.windowId).state, "normal");
assert.equal(f.tabs.get(work.tabId).mutedInfo.muted, false);
await assert.rejects(f.command("setPlaying", { sourceId, playing: true }));
await assert.rejects(f.command("open", { url: `https://www.youtube.com/watch?v=${fixtureId}` }));
await f.command("pauseAndMinimize");
await f.command("restorePaused");
assert.equal(f.windows.get(primary.windowId).state, "normal");
assert.equal((await f.command("getState")).state.playing, false);
assert.equal(f.tabs.get(primary.id).mutedInfo.muted, true);
await f.command("setPlaying", { sourceId, playing: true });
assert.equal(f.tabs.get(primary.id).mutedInfo.muted, false);
const unrelatedTab = 700;
f.tabs.set(unrelatedTab, { id: unrelatedTab, windowId: primary.windowId, url: "https://example.org/work", mutedInfo: { muted: false } });
f.windows.get(primary.windowId).tabs.push(unrelatedTab);
const partial = await f.command("pauseAndMinimize");
assert.equal(partial.state.partial, true);
assert.equal(f.windows.get(primary.windowId).state, "normal");
assert.equal(f.tabs.get(primary.id).mutedInfo.muted, true);
assert.equal(f.tabs.get(unrelatedTab).mutedInfo.muted, false);

console.log("Checking pending native window creation and repeated concealment...");
const late = createFixture(); await late.pair();
const create = late.delayCreate();
const pendingOpen = late.command("open", { url: `https://www.youtube.com/watch?v=${fixtureId}` });
await until(() => create.entered, "Native window creation did not start");
const conceal = late.command("pauseAndMinimize");
await assert.rejects(late.command("open", { url: `https://www.youtube.com/watch?v=${fixtureId}` }));
create.resolve(); await Promise.all([pendingOpen, conceal]);
const lateTab = [...late.tabs.values()][0];
assert.equal(late.windows.get(lateTab.windowId).state, "minimized");
assert.equal(late.tabs.get(lateTab.id).mutedInfo.muted, true);
assert.equal(late.tabs.get(lateTab.id).url, `chrome-extension://${extensionId}/launch.html`);
assert.equal(late.records.some(record => record.api === "windows.update" && record.options.state === "normal"), false);
await late.command("pauseAndMinimize");
await late.command("restorePaused");
assert.equal(late.windows.get(lateTab.windowId).state, "minimized");

const attaching = createFixture(); await attaching.pair();
const attach = attaching.delayAttach();
const pendingAttach = attaching.command("open", { url: `https://www.youtube.com/watch?v=${fixtureId}` });
await until(() => attach.entered, "Content attachment did not start");
const hideWhileAttaching = attaching.command("pauseAndMinimize");
attach.resolve(); await Promise.all([pendingAttach, hideWhileAttaching]);
assert.equal(attaching.records.some(record => record.api === "windows.update" && record.options.state === "normal"), false);
const closing = createFixture(); await closing.pair();
const closingCreate = closing.delayCreate();
const pendingClosingOpen = closing.command("open", { url: `https://www.youtube.com/watch?v=${fixtureId}` });
await until(() => closingCreate.entered, "Closing fixture did not start window creation");
const pendingClose = closing.command("close");
closingCreate.resolve(); await Promise.all([pendingClosingOpen, pendingClose]);
assert.equal(closing.windows.size, 0);

console.log("Checking restore races and disconnection concealment...");
const race = createFixture(); await race.pair();
await race.command("open", { url: `https://www.youtube.com/watch?v=${fixtureId}` });
const raceTab = [...race.tabs.values()][0]; race.media(raceTab.id); await tick();
await race.command("pauseAndMinimize");
const hold = race.delayHold();
const restoring = race.command("restorePaused");
await until(() => hold.entered, "Restore did not request paused media");
const rehiding = race.command("pauseAndMinimize");
hold.resolve(); await Promise.all([restoring, rehiding]);
assert.equal(race.windows.get(raceTab.windowId).state, "minimized");
assert.equal((await race.command("getState")).state.playing, false);
await race.command("restorePaused");
const source = (await race.command("getState")).state.sourceId;
const play = race.delayPlay();
const delayedPlay = race.command("setPlaying", { sourceId: source, playing: true });
const stalePlay = assert.rejects(delayedPlay);
await until(() => play.entered, "Playback control did not start");
await race.command("pauseAndMinimize");
await race.command("restorePaused");
play.resolve(); await stalePlay;
assert.equal(race.tabs.get(raceTab.id).mutedInfo.muted, true);
assert.equal((await race.command("getState")).state.playing, false);
race.sockets.at(-1).close();
await until(() => race.tabs.get(raceTab.id).mutedInfo.muted && race.windows.get(raceTab.windowId).state === "minimized", "Disconnect did not conceal managed media");
assert.equal((await race.hello(raceTab.id)).suspended, true);

console.log("Checking browser replacement does not reconnect or leak an old command response...");
const replaced = createFixture(); await replaced.pair();
replaced.sockets.at(-1).close(1000, "Replaced");
await until(() => replaced.storage.touchfishConnection === null, "Replaced browser kept its connection credentials");
assert.equal(replaced.records.some(record => record.api === "setTimeout" && record.duration === 5000), false);
const switching = createFixture(); await switching.pair();
const oldSocket = switching.sockets.at(-1), switchCreate = switching.delayCreate();
oldSocket.receive({ type: "command", id: 999, action: "open", args: { url: `https://www.youtube.com/watch?v=${fixtureId}` } });
await until(() => switchCreate.entered, "Old browser command did not start");
await switching.external({ type: "touchfish-pair", url: bridgeUrl, token });
await until(() => switching.sockets.length === 2 && switching.sockets.at(-1).readyState === 1, "New browser connection did not open");
switchCreate.resolve();
await until(() => switching.records.some(record => record.api === "tabs.sendMessage" && record.message.action === "hold"), "Old command did not finish concealment");
await tick(); await tick();
assert.equal(switching.sockets.at(-1).sent.some(message => message.type === "response" && message.id === 999), false);
console.log("PASS: extension identity and scope, exact pairing sender and tab cleanup, managed-only mute/concealment, paused restore, late creation/control guards, mixed windows, restore race, disconnect, and browser replacement isolation.");

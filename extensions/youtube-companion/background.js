// No cookie, account, history, debugger, or all-tabs access is requested.
const PROTOCOL = "touchfish-youtube-v1";
let socket = null, ping = null, reconnect = null, connection = null;
let suspended = false, operation = 0, lastControl = 0, opening = null, media = null;
let primaryTab = null, primaryWindow = null;
let initialized = Promise.resolve();
const ownedTabs = new Set(), ownedWindows = new Set(), previouslyVisible = new Set();
const videoId = value => { try { const u = new URL(value); if (u.origin !== "https://www.youtube.com") return null; const id = u.pathname === "/watch" ? u.searchParams.get("v") : /^\/(?:shorts|live)\/([A-Za-z0-9_-]{11})/.exec(u.pathname)?.[1]; return /^[A-Za-z0-9_-]{11}$/.test(id ?? "") ? id : null; } catch { return null; } };
const safeUrl = value => typeof value === "string" && /^https:\/\/www\.youtube\.com\/(?:watch\?v=[A-Za-z0-9_-]{11}|)$/.test(value);
function send(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
async function save() { await chrome.storage.session.set({ touchfishManaged: { tabs: [...ownedTabs], windows: [...ownedWindows], primaryTab, primaryWindow }, touchfishConnection: connection }); }
async function safeWindow(id) {
  try { const win = await chrome.windows.get(id, { populate: true }); return win.tabs?.length && win.tabs.every(tab => ownedTabs.has(tab.id)) ? win : null; }
  catch { return null; }
}
async function tabMessage(action, args = {}) {
  if (primaryTab === null) return { exists: false, ready: false, playing: false, playIntent: false, buffering: false, ended: false, failed: false };
  return await Promise.race([
    chrome.tabs.sendMessage(primaryTab, { type: "touchfish-control", action, generation: operation, ...args }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("YouTube did not respond")), 1800)),
  ]);
}
async function status() {
  if (primaryWindow === null || !ownedWindows.has(primaryWindow)) return { open: false };
  const win = await safeWindow(primaryWindow);
  if (!win) return { open: true, visible: true, minimized: false, ready: false, playing: false, playIntent: false, buffering: false, ended: false, failed: true, partial: true, sourceId: "mixed" };
  return { open: true, visible: win.state !== "minimized", minimized: win.state === "minimized", title: media?.title ?? "YouTube", videoId: media?.videoId ?? null,
    sourceId: media?.sourceId ?? "pending", ready: !!media?.ready, playing: !suspended && !!media?.playing, playIntent: !suspended && !!media?.playIntent,
    buffering: !suspended && !!media?.buffering, ended: !!media?.ended, failed: !!media?.failed,
    currentTime: media?.currentTime ?? 0, duration: media?.duration ?? 0, volume: media?.volume ?? 1, playbackRate: media?.playbackRate ?? 1 };
}
async function publish() { send({ type: "state", state: await status() }); }
async function minimizeOwned(capture = false) {
  let partial = false;
  for (const id of ownedWindows) {
    const win = await safeWindow(id);
    if (!win) { partial = true; continue; }
    if (capture && win.state !== "minimized") previouslyVisible.add(id);
    await chrome.windows.update(id, { state: "minimized" }).catch(() => {});
  }
  return partial;
}
async function pauseAndMinimize(captureBeforeHide = !suspended) {
  suspended = true; ++operation;
  if (captureBeforeHide) previouslyVisible.clear();
  // Native mute silences an unresponsive renderer before its pause command.
  await Promise.all([minimizeOwned(captureBeforeHide), Promise.all([...ownedTabs].map(id => chrome.tabs.update(id, { muted: true }).catch(() => {})))]);
  await tabMessage("hold").catch(() => {});
  if (opening) await opening.catch(() => {});
  await minimizeOwned(false);
  if (media) media = { ...media, playing: false, playIntent: false, buffering: false };
  return { state: await status() };
}
async function openVideo(url) {
  if (!safeUrl(url)) throw new Error("Invalid YouTube destination");
  if (suspended) throw new Error("TouchFish windows are concealed");
  const currentOperation = ++operation;
  const job = (async () => {
    media = null;
    let win = primaryWindow === null ? null : await safeWindow(primaryWindow);
    if (currentOperation !== operation || suspended) return { state: await status() };
    if (win && primaryTab !== null) {
      await chrome.tabs.update(primaryTab, { url, muted: true });
    } else {
      // A late create response must never reveal a window after the boss key.
      // Start with an inert extension page, so even an async create cannot
      // autoplay media before its tab ID is known and native mute is applied.
      win = await chrome.windows.create({ url: chrome.runtime.getURL("launch.html"), type: "popup", state: "minimized", focused: false });
      const tab = win.tabs?.[0];
      if (!Number.isInteger(win.id) || !Number.isInteger(tab?.id)) throw new Error("Browser did not create the dedicated window");
      primaryWindow = win.id; primaryTab = tab.id; ownedWindows.add(win.id); ownedTabs.add(tab.id); await save();
      await chrome.tabs.update(primaryTab, { muted: true });
      if (currentOperation === operation && !suspended) await chrome.tabs.update(primaryTab, { url });
    }
    if (currentOperation !== operation || suspended) {
      if (primaryTab !== null) { await chrome.tabs.update(primaryTab, { muted: true }).catch(() => {}); await tabMessage("hold").catch(() => {}); }
      await minimizeOwned(false); return { state: await status() };
    }
    await tabMessage("attach", { generation: currentOperation }).catch(() => {});
    if (currentOperation !== operation || suspended) { await minimizeOwned(false); return { state: await status() }; }
    await chrome.windows.update(primaryWindow, { state: "normal", focused: true });
    if (currentOperation !== operation || suspended) await minimizeOwned(false);
    else await chrome.windows.update(primaryWindow, { width: 960, height: 640 }).catch(() => {});
    return { state: await status() };
  })();
  opening = job;
  try { return await job; } finally { if (opening === job) opening = null; }
}
async function restorePaused(show = true) {
  const currentOperation = ++operation;
  suspended = false;
  await Promise.all([...ownedTabs].map(id => chrome.tabs.update(id, { muted: true }).catch(() => {})));
  await tabMessage("hold").catch(() => {});
  if (currentOperation !== operation || suspended) return { state: await status() };
  for (const id of show ? [...previouslyVisible] : []) {
    if (currentOperation !== operation || suspended) break;
    const win = await safeWindow(id);
    if (currentOperation !== operation || suspended) break;
    if (win) await chrome.windows.update(id, { state: "normal", focused: false }).catch(() => {});
    if (currentOperation !== operation || suspended) await minimizeOwned(false);
  }
  if (currentOperation === operation && !suspended) previouslyVisible.clear();
  if (media) media = { ...media, playing: false, playIntent: false, buffering: false };
  return { state: await status() };
}
async function command(message) {
  const args = message.args ?? {};
  switch (message.action) {
    case "getState": return { state: await status() };
    case "open": return openVideo(args.url);
    case "openSite": return openVideo("https://www.youtube.com/");
    case "pauseAndMinimize": return pauseAndMinimize(message.captureBeforeHide);
    case "restorePaused": return restorePaused(args.show !== false);
    case "setPlaying":
    case "setVolume":
    case "setPlaybackRate": {
      if (args.sourceId !== media?.sourceId || !media?.ready) throw new Error("Media source changed");
      if (message.action === "setPlaying" && (typeof args.playing !== "boolean" || suspended && args.playing)) throw new Error("Invalid or concealed playback request");
      if (message.action === "setVolume" && (!Number.isFinite(args.volume) || args.volume < 0 || args.volume > 1)) throw new Error("Invalid volume");
      if (message.action === "setPlaybackRate" && (!Number.isFinite(args.rate) || args.rate < .25 || args.rate > 4)) throw new Error("Invalid rate");
      const previousSource = media.sourceId;
      const currentOperation = operation, currentControl = ++lastControl;
      const next = await tabMessage(message.action, args);
      if (media?.sourceId !== previousSource || currentOperation !== operation || currentControl !== lastControl) throw new Error("Media source or intent changed");
      media = { ...next, sourceId: previousSource };
      if (message.action === "setPlaying" && args.playing && !suspended) await chrome.tabs.update(primaryTab, { muted: false });
      return { state: await status() };
    }
    case "show": {
      const currentOperation = operation;
      const id = primaryWindow;
      const win = id === null ? null : await safeWindow(id);
      if (!suspended && currentOperation === operation && win) await chrome.windows.update(id, { state: "normal", focused: true });
      if (suspended || currentOperation !== operation) await minimizeOwned(false);
      return { state: await status() };
    }
    case "minimize": await minimizeOwned(false); return { state: await status() };
    case "close": {
      const currentOperation = ++operation;
      if (opening) await opening.catch(() => {});
      for (const id of [...ownedWindows]) if (await safeWindow(id) && currentOperation === operation) await chrome.windows.remove(id).catch(() => {});
      return { state: await status() };
    }
    default: throw new Error("Unsupported command");
  }
}
function connect() {
  clearInterval(ping); clearTimeout(reconnect);
  if (!connection) return;
  const current = new WebSocket(connection.url, [PROTOCOL, connection.token]);
  socket?.close(); socket = current;
  current.onopen = () => {
    if (socket !== current) return;
    send({ type: "hello", version: 1, browser: navigator.userAgent.includes("Edg/") ? "edge" : "chrome" });
    void chrome.action?.setTitle({ title: "TouchFish YouTube Companion" }).catch(() => {});
    ping = setInterval(() => send({ type: "ping" }), 20000);
  };
  current.onmessage = event => {
    if (socket !== current) return;
    let message; try { message = JSON.parse(event.data); } catch { current.close(); return; }
    if (message.type !== "command" || !Number.isSafeInteger(message.id) || typeof message.action !== "string") return;
    // The conceal latch is set before any async operation can yield.
    if (message.action === "pauseAndMinimize") { message.captureBeforeHide = !suspended; suspended = true; }
    const respond = value => { if (socket === current && current.readyState === WebSocket.OPEN) current.send(JSON.stringify(value)); };
    void command(message).then(result => respond({ type: "response", id: message.id, ok: true, result }), () => respond({ type: "response", id: message.id, ok: false }));
  };
  current.onclose = event => {
    if (socket !== current) return;
    socket = null; clearInterval(ping);
    void pauseAndMinimize();
    if (event?.code === 1000 && event.reason === "Replaced") {
      connection = null; void save();
      void chrome.action?.setTitle({ title: "连接已由其他浏览器接管，请回到摸鱼时钟重新配对。" }).catch(() => {});
    } else reconnect = setTimeout(connect, 5000);
  };
  current.onerror = () => {};
}
chrome.runtime.onMessageExternal.addListener((message, sender, respond) => {
  let source, destination;
  try { source = new URL(sender.url); destination = new URL(message.url); } catch { respond({ ok: false }); return false; }
  if (message.type !== "touchfish-pair" || source.protocol !== "http:" || source.hostname !== "127.0.0.1" || source.username || source.password || source.pathname !== "/pair" ||
    destination.protocol !== "ws:" || destination.hostname !== "127.0.0.1" || destination.port !== source.port || destination.pathname !== "/bridge" || destination.search || destination.hash ||
    !/^[a-f0-9]{48}$/.test(message.token)) { respond({ ok: false }); return false; }
  void initialized.then(async () => {
    connection = { url: destination.toString(), token: message.token }; await save(); connect(); respond({ ok: true });
    // Only the validated local pairing tab is closed, never another browser tab
    // or its containing window. Pairing is not a long-lived media window.
    if (Number.isInteger(sender.tab?.id)) {
      try {
        const tab = await chrome.tabs.get(sender.tab.id), current = new URL(tab.url);
        if (current.origin === source.origin && current.pathname === "/pair" && !current.username && !current.password) await chrome.tabs.remove(tab.id);
      } catch { /* The user may already have closed the pairing tab. */ }
    }
  });
  return true;
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id)) { respond({ managed: false }); return false; }
  if (message.type === "touchfish-hello") {
    void initialized.then(() => respond({ managed: ownedTabs.has(sender.tab.id), suspended, generation: operation }));
    return true;
  }
  if (!ownedTabs.has(sender.tab.id)) { respond({ managed: false }); return false; }
  if (message.type === "touchfish-media" && sender.tab.id === primaryTab) {
    const value = message.state;
    if (!value || typeof value !== "object" || typeof value.ready !== "boolean" || !/^[A-Za-z0-9_-]{11}$/.test(value.videoId ?? "")) return false;
    media = { ...value, sourceId: `${primaryTab}:${sender.documentId ?? "document"}:${value.videoId}` };
    if (suspended) { void tabMessage("hold").catch(() => {}); media.playing = false; media.playIntent = false; }
    else if (media.playIntent) void chrome.tabs.update(primaryTab, { muted: false }).catch(() => {});
    void publish();
  }
  return false;
});
chrome.tabs.onCreated.addListener(tab => {
  if (!ownedTabs.has(tab.openerTabId) || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId)) return;
  const createdAtOperation = operation;
  void chrome.windows.get(tab.windowId, { populate: true }).then(win => {
    if (win.tabs?.length === 1 && win.tabs[0].id === tab.id) {
      ownedTabs.add(tab.id); ownedWindows.add(tab.windowId); void save();
      if (suspended || createdAtOperation !== operation) {
        void chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
        void safeWindow(tab.windowId).then(current => current && chrome.windows.update(tab.windowId, { state: "minimized" })).catch(() => {});
      }
    }
  }).catch(() => {});
});
chrome.tabs.onRemoved.addListener(id => { ownedTabs.delete(id); if (id === primaryTab) { primaryTab = null; media = null; } void save(); void publish(); });
chrome.windows.onRemoved.addListener(id => { ownedWindows.delete(id); previouslyVisible.delete(id); if (id === primaryWindow) { primaryWindow = null; primaryTab = null; media = null; } void save(); void publish(); });
chrome.windows.onBoundsChanged.addListener(win => { if (ownedWindows.has(win.id)) void publish(); });
chrome.tabs.onUpdated.addListener((id, change) => { if (id === primaryTab && change.url) { media = null; void publish(); } });
initialized = chrome.storage.session.get(["touchfishManaged", "touchfishConnection", "touchfishGeneration"]).then(async saved => {
  // Reserve a new monotonically increasing generation range before connecting.
  // Content scripts survive MV3 worker restarts; restarting must not make their
  // stale-control protection reject all commands from the new worker.
  const generation = Number.isSafeInteger(saved.touchfishGeneration) && saved.touchfishGeneration >= 0 ? saved.touchfishGeneration + 1 : 1;
  if (generation >= 2_000_000) throw new Error("Companion session generation exhausted; restart the browser");
  await chrome.storage.session.set({ touchfishGeneration: generation });
  operation = generation * 4_294_967_296;
  const managed = saved.touchfishManaged;
  if (managed) { for (const id of managed.tabs ?? []) if (Number.isInteger(id)) ownedTabs.add(id); for (const id of managed.windows ?? []) if (Number.isInteger(id)) ownedWindows.add(id); primaryTab = managed.primaryTab ?? null; primaryWindow = managed.primaryWindow ?? null; }
  connection = saved.touchfishConnection ?? null;
  // Session storage is cleared by a browser restart; IDs are never trusted from local storage.
  if (connection) connect();
});

import { shell } from "electron";
import { createServer, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { WebSocketServer, WebSocket } from "ws";
import { createBilibiliTransport } from "./bilibili-transport";
import { isBridgeHost, isYouTubeExtensionOrigin, normalizeYouTubeVideo, validYouTubeBrowser, YOUTUBE_BRIDGE_PROTOCOL, YOUTUBE_EXTENSION_ID } from "./youtube-policy";
import type { BiliTransportState } from "../src/bilibili-types";
import type { YouTubeBrowser, YouTubePlayerState } from "../src/youtube-types";

interface YouTubeOptions {
  extensionDirectory: string;
  onState: (state: YouTubePlayerState) => void;
  onTransportState: (state: BiliTransportState) => void;
  /** Test seam: browser opening never comes from the extension or a web page. */
  openBrowser?: (url: string, browser: YouTubeBrowser) => Promise<void>;
}
interface Pending { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const cleanText = (value: unknown, maximum = 160) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, maximum) : "";

async function launchBrowser(url: string, browser: YouTubeBrowser): Promise<void> {
  if (browser === "default") return shell.openExternal(url);
  const name = browser === "chrome" ? "Google Chrome" : "Microsoft Edge";
  let candidates: string[][];
  if (process.platform === "win32") {
    const suffix = browser === "chrome" ? ["Google", "Chrome", "Application", "chrome.exe"] : ["Microsoft", "Edge", "Application", "msedge.exe"];
    candidates = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]
      .filter((directory): directory is string => !!directory).map(directory => [join(directory, ...suffix), "--new-window", url]).filter(args => existsSync(args[0]));
  } else if (process.platform === "darwin") candidates = [["/usr/bin/open", "-a", name, url]];
  else candidates = (browser === "chrome" ? ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"] : ["microsoft-edge", "microsoft-edge-stable"])
    .map(binary => [binary, "--new-window", url]);
  for (const [binary, ...args] of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(binary, args, { detached: true, stdio: "ignore", windowsHide: false });
        child.once("error", reject); child.once("spawn", () => { child.unref(); resolve(); });
      });
      return;
    } catch { /* Try the next installed binary, never a shell-built command. */ }
  }
  throw new Error(`未能打开 ${name}，请先安装浏览器或使用默认浏览器连接。`);
}

/** A loopback companion bridge; the browser owns login cookies and playback. */
export async function createYouTubeWindow(options: YouTubeOptions) {
  const launch = options.openBrowser ?? launchBrowser;
  const token = randomBytes(24).toString("hex");
  let port = 0, nextRequest = 0, disposed = false, epoch = 0;
  let socket: WebSocket | null = null;
  let sourceId: string | null = null;
  let pairCode: { code: string; expiresAt: number } | null = null;
  let state: YouTubePlayerState = { connected: false, browser: null, open: false, visible: false, minimized: false,
    loading: false, concealed: false, title: "", videoId: null, url: null, message: "请先加载配套扩展并连接 Chrome 或 Edge。",
    currentTime: 0, duration: 0, volume: 1, playbackRate: 1 };
  const pending = new Map<number, Pending>();
  const getState = () => ({ ...state });
  const publish = (patch: Partial<YouTubePlayerState> = {}) => { state = { ...state, ...patch }; if (!disposed) options.onState(getState()); };
  function cancelPending(message: string) {
    for (const command of pending.values()) { clearTimeout(command.timer); command.reject(new Error(message)); }
    pending.clear();
  }
  function send(action: string, args: Record<string, unknown> = {}, timeout = 5000): Promise<Record<string, unknown>> {
    if (disposed || !state.connected || socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("浏览器扩展尚未连接，请先连接浏览器。"));
    const id = ++nextRequest;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error("浏览器未及时响应，请检查扩展连接。")); }, timeout);
      pending.set(id, { resolve, reject, timer });
      try { socket!.send(JSON.stringify({ type: "command", id, action, args })); }
      catch { clearTimeout(timer); pending.delete(id); reject(new Error("浏览器连接已中断。")); }
    });
  }
  const transport = createBilibiliTransport({
    onState: options.onTransportState,
    send: command => {
      if (state.concealed && command.playing) throw new Error("请先恢复摸鱼窗口。");
      const expectedSource = sourceId;
      void send("setPlaying", { playing: command.playing, sourceId: expectedSource }).then(result => {
        if (disposed || command.revision !== transport.getState().revision || expectedSource !== sourceId) return;
        acceptState(result.state, command.id);
      }).catch(() => {
        if (command.revision === transport.getState().revision)
          transport.report({ revision: command.revision, ready: false, playing: false, playIntent: false, buffering: false, ended: false, failed: true }, command.id);
      });
    },
  });
  function acceptState(raw: unknown, commandId?: number) {
    if (!plain(raw) || typeof raw.open !== "boolean") return;
    if (!raw.open) {
      if (state.open || transport.getState().open) transport.close();
      sourceId = null;
      publish({ open: false, visible: false, minimized: false, loading: false, title: "", videoId: null, url: null });
      return;
    }
    const currentSource = cleanText(raw.sourceId, 256) || "pending";
    if (!transport.getState().open || sourceId !== currentSource) { sourceId = currentSource; transport.beginSource(); }
    const videoId = typeof raw.videoId === "string" && /^[A-Za-z0-9_-]{11}$/.test(raw.videoId) ? raw.videoId : null;
    const concealed = state.concealed;
    transport.report({ revision: transport.getState().revision, ready: raw.ready === true,
      playing: !concealed && raw.playing === true, playIntent: !concealed && raw.playIntent === true,
      buffering: !concealed && raw.buffering === true, ended: raw.ended === true, failed: raw.failed === true }, commandId);
    publish({ open: true, visible: !concealed && raw.visible === true, minimized: concealed || raw.minimized === true,
      loading: raw.ready !== true, title: cleanText(raw.title) || "YouTube", videoId,
      url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : state.url,
      currentTime: typeof raw.currentTime === "number" && Number.isFinite(raw.currentTime) ? Math.max(0, Math.min(raw.currentTime, 604800)) : 0,
      duration: typeof raw.duration === "number" && Number.isFinite(raw.duration) ? Math.max(0, Math.min(raw.duration, 604800)) : 0,
      volume: typeof raw.volume === "number" && Number.isFinite(raw.volume) ? Math.max(0, Math.min(raw.volume, 1)) : state.volume,
      playbackRate: typeof raw.playbackRate === "number" && Number.isFinite(raw.playbackRate) ? Math.max(.25, Math.min(raw.playbackRate, 4)) : state.playbackRate,
      message: raw.partial === true ? "专属窗口混入了其他标签页；已暂停视频，请将 YouTube 移回独立窗口。" : "已连接真实浏览器，账号与播放由浏览器处理。" });
  }
  const bootstrap = `const data=JSON.parse(document.getElementById('config').textContent);const button=document.getElementById('connect');const status=document.getElementById('status');history.replaceState(null,'','/pair');button.addEventListener('click',()=>{button.disabled=true;if(!window.chrome?.runtime?.sendMessage){status.textContent='请先在 Chrome 或 Edge 中加载配套扩展，再返回应用重新连接。';button.disabled=false;return;}chrome.runtime.sendMessage(data.extensionId,{type:'touchfish-pair',url:data.url,token:data.token},response=>{const error=chrome.runtime.lastError;if(error||!response?.ok){status.textContent='未找到配套扩展，请加载扩展后在应用重新连接。';button.disabled=false;}else{status.textContent='浏览器已连接，可以关闭本页并回到摸鱼时钟输入视频链接。';}});});`;
  function reply(response: ServerResponse, status: number, content: string, type = "text/plain; charset=utf-8") {
    response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
    response.end(content);
  }
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    if (!isBridgeHost(request.headers.host, port) || request.socket.remoteAddress !== "127.0.0.1" || request.headers.origin) { reply(response, 403, "Forbidden"); return; }
    if (request.method !== "GET") { reply(response, 405, "Method not allowed"); return; }
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.origin !== `http://127.0.0.1:${port}` || url.username || url.password) { reply(response, 403, "Forbidden"); return; }
    if (url.pathname === "/pair.js") { reply(response, 200, bootstrap, "text/javascript; charset=utf-8"); return; }
    const code = url.searchParams.get("code");
    if (url.pathname !== "/pair" || !pairCode || pairCode.expiresAt < Date.now() || code !== pairCode.code) { reply(response, 410, "连接链接已过期，请回到摸鱼时钟重新连接。"); return; }
    pairCode = null;
    const config = JSON.stringify({ extensionId: YOUTUBE_EXTENSION_ID, url: `ws://127.0.0.1:${port}/bridge`, token });
    reply(response, 200, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接摸鱼时钟</title><style>body{font:16px system-ui;max-width:580px;margin:70px auto;padding:25px;color:#233a30;background:#f5faf7}button{padding:12px 24px;background:#18976c;color:white;border:0;border-radius:12px;cursor:pointer}p{line-height:1.8;color:#63786c}</style><h1>连接摸鱼时钟</h1><p>配套扩展只控制摸鱼时钟创建的 YouTube 专属窗口，不会读取账号 Cookie 或操作其他工作标签页。</p><button id="connect">连接此浏览器</button><p id="status">请先加载配套扩展，再点击连接。</p><script type="application/json" id="config">${config}</script><script src="/pair.js"></script></html>`, "text/html; charset=utf-8");
  });
  server.headersTimeout = 5000; server.requestTimeout = 5000; server.keepAliveTimeout = 1000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false, handleProtocols: protocols => protocols.has(YOUTUBE_BRIDGE_PROTOCOL) ? YOUTUBE_BRIDGE_PROTOCOL : false });
  server.on("upgrade", (request, client, head) => {
    const protocols = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map(value => value.trim());
    const credential = protocols.find(value => /^[a-f0-9]{48}$/.test(value));
    const authenticated = credential?.length === token.length && timingSafeEqual(Buffer.from(credential), Buffer.from(token));
    if (!isBridgeHost(request.headers.host, port) || request.socket.remoteAddress !== "127.0.0.1" || request.url !== "/bridge" ||
      !isYouTubeExtensionOrigin(request.headers.origin) || protocols.length !== 2 || !protocols.includes(YOUTUBE_BRIDGE_PROTOCOL) || !authenticated) {
      client.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); client.destroy(); return;
    }
    wss.handleUpgrade(request, client, head, ws => wss.emit("connection", ws));
  });
  wss.on("connection", ws => {
    const previous = socket; socket = ws; previous?.close(1000, "Replaced");
    cancelPending("浏览器连接已替换。");
    ws.on("error", () => {});
    ws.on("message", data => {
      if (socket !== ws || disposed) return;
      let message: unknown;
      try { message = JSON.parse(data.toString()); } catch { ws.close(1008, "Invalid message"); return; }
      if (!plain(message)) return;
      if (message.type === "hello" && message.version === 1 && validYouTubeBrowser(message.browser)) {
        publish({ connected: true, browser: message.browser, message: "浏览器扩展已连接。" });
        if (state.concealed) void send("pauseAndMinimize").then(result => acceptState(result.state)).catch(() => {});
        // Re-pairing releases the old disconnect latch without automatically
        // restoring a browser window or resuming its media.
        else void send("restorePaused", { show: false }).then(result => acceptState(result.state)).catch(() => {});
      } else if (message.type === "state" && state.connected) acceptState(message.state);
      else if (message.type === "response" && Number.isSafeInteger(message.id)) {
        const item = pending.get(Number(message.id));
        if (!item) return;
        pending.delete(Number(message.id)); clearTimeout(item.timer);
        if (message.ok === true) item.resolve(plain(message.result) ? message.result : {});
        else item.reject(new Error("浏览器未能完成操作，请在专属窗口中重试。"));
      } else if (message.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    });
    ws.on("close", () => {
      if (socket !== ws) return;
      socket = null; cancelPending("浏览器扩展连接已断开。"); transport.close(); sourceId = null;
      publish({ connected: false, open: false, visible: false, minimized: false, loading: false, message: "浏览器连接已断开，请重新连接；扩展会暂停并收起专属窗口。" });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  port = (server.address() as { port: number }).port;

  async function connectBrowser(browser: YouTubeBrowser = "default") {
    if (!validYouTubeBrowser(browser)) throw new Error("浏览器选项无效。");
    if (disposed) throw new Error("YouTube 连接已关闭。");
    pairCode = { code: randomBytes(24).toString("hex"), expiresAt: Date.now() + 120_000 };
    await launch(`http://127.0.0.1:${port}/pair?code=${pairCode.code}`, browser);
    publish({ message: "请在浏览器连接页面点击“连接此浏览器”。" });
    return getState();
  }
  async function open(input: string) {
    if (state.concealed) throw new Error("请先恢复摸鱼窗口，再打开视频。");
    const video = normalizeYouTubeVideo(input), operation = ++epoch;
    publish({ loading: true, ...video, title: "YouTube" });
    try {
      const result = await send("open", { url: video.url });
      if (operation !== epoch || state.concealed) throw new Error("播放请求已取消。");
      acceptState(result.state); return getState();
    } catch (error) {
      if (operation === epoch) publish({ loading: false, message: "浏览器未能打开视频，请检查连接后重试。" });
      throw error;
    }
  }
  async function openSite() {
    if (state.concealed) throw new Error("请先恢复摸鱼窗口。");
    const operation = ++epoch;
    try {
      const result = await send("openSite");
      if (operation !== epoch || state.concealed) throw new Error("打开网页的请求已取消。");
      acceptState(result.state);
    } catch (error) {
      if (operation === epoch) publish({ loading: false, message: "浏览器未能打开网页，请检查连接后重试。" });
      throw error;
    }
  }
  async function pauseAndHide() {
    epoch++; publish({ concealed: true, visible: false, minimized: state.open });
    const current = transport.getState();
    if (current.open) transport.report({ ...current, playing: false, playIntent: false, buffering: false });
    if (state.connected) { const result = await send("pauseAndMinimize", {}, 2500); acceptState(result.state); }
  }
  function restorePaused() {
    const operation = ++epoch; publish({ concealed: false });
    if (state.connected) void send("restorePaused").then(result => { if (operation === epoch && !state.concealed) acceptState(result.state); }).catch(() => { if (operation === epoch) publish({ message: "浏览器未能恢复，请检查专属窗口。" }); });
  }
  return {
    getState, getTransportState: transport.getState, connectBrowser, open,
    setPlaying: (playing: boolean, revision: number) => {
      if (state.concealed && playing) return Promise.reject(new Error("请先恢复摸鱼窗口。"));
      return transport.setPlaying(playing, revision);
    },
    async setVolume(volume: number) { if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error("音量参数无效。"); await send("setVolume", { volume, sourceId }); },
    async setPlaybackRate(rate: number) { if (!Number.isFinite(rate) || rate < 0.25 || rate > 4) throw new Error("播放速度无效。"); await send("setPlaybackRate", { rate, sourceId }); },
    show: () => { const operation = epoch; if (!state.concealed) void send("show").then(result => { if (operation === epoch && !state.concealed) acceptState(result.state); }).catch(() => {}); },
    minimize: () => { const operation = epoch; void send("minimize").then(result => { if (operation === epoch) acceptState(result.state); }).catch(() => {}); },
    close: () => { const operation = ++epoch; void send("close").then(result => { if (operation === epoch) acceptState(result.state); }).catch(() => {}); },
    pauseAndHide, restorePaused,
    async openInBrowser(input?: string) { if (input || state.url) await open(input ?? state.url!); else await openSite(); },
    openLogin: openSite,
    async openExtensionFolder() { const error = await shell.openPath(options.extensionDirectory); if (error) throw new Error("无法打开扩展目录，请检查安装是否完整。"); },
    async flush() { /* Browser profile owns account/session persistence. */ },
    dispose() {
      if (disposed) return;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "command", id: ++nextRequest, action: "pauseAndMinimize", args: {} }));
      disposed = true; epoch++; cancelPending("应用已退出。"); transport.close(); socket?.close();
      for (const client of wss.clients) client.close(); wss.close(); server.close(); server.closeIdleConnections();
    },
  };
}

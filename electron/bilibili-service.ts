import { app, net, session, type ClientRequest, type Session } from "electron";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import QRCode from "qrcode";
import type { BiliAuthState, BiliDanmaku, BiliPlayback, BiliPlayRequest, BiliQuality, BiliVideo } from "../src/bilibili-types";
import { normalizeBvid, normalizeBiliMediaUrl, parseDanmakuXml, safeBiliError, signWbi, trustedBiliApiUrl, trustedBiliMediaUrl } from "./bilibili-policy";

const API = "https://api.bilibili.com";
const PASSPORT = "https://passport.bilibili.com";
const REFERER = "https://www.bilibili.com/";
const SESSION_PARTITION = "persist:touchfish-bilibili";
const SECOND = 1000;
const MAX_JSON = 4 * 1024 * 1024;
const MAX_XML = 8 * 1024 * 1024;
const QUALITY_NAMES: Record<number, string> = { 16: "360P", 32: "480P", 64: "720P", 74: "720P 60帧", 80: "1080P", 112: "1080P+", 116: "1080P 60帧", 120: "4K", 125: "HDR", 126: "杜比视界", 127: "8K" };

interface BilibiliOptions {
  onAuth: (state: BiliAuthState) => void;
  networkSession?: Session;
  now?: () => number;
  requestTimeoutMs?: number;
  /** Main-process-only fixture injection; never comes from a renderer. */
  qrPollIntervalMs?: number;
}
interface MediaEntry { urls: string[]; expiresAt: number; kind: "image" | "media" }
interface NetworkResponse { response: Response; cookies: string[] }
type JsonObject = Record<string, any>;
const object = (value: unknown): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 400): string => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : "";
const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/** Credentials stay in Chromium's dedicated, persistent cookie store. */
export async function createBilibiliService(options: BilibiliOptions) {
  const network = options.networkSession ?? session.fromPartition(SESSION_PARTITION, { cache: false });
  const now = options.now ?? Date.now;
  const timeout = Math.max(500, Math.min(options.requestTimeoutMs ?? 15_000, 60_000));
  const pollInterval = Math.max(100, options.qrPollIntervalMs ?? 2000);
  const platform = process.platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : process.platform === "linux" ? "X11; Linux x86_64" : "Windows NT 10.0; Win64; x64";
  const userAgent = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
  network.setUserAgent(userAgent, "zh-CN,zh;q=0.9,en;q=0.7");
  const requests = new Set<AbortController>();
  const media = new Map<string, MediaEntry>();
  const videoCache = new Map<string, { value: BiliVideo; until: number }>();
  const danmakuCache = new Map<number, { value: BiliDanmaku[]; until: number }>();
  const protocolSessions = new Set<Session>();
  let disposed = false;
  let generation = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let loginRequest: AbortController | null = null;
  let credentialQueue: Promise<void> = Promise.resolve();
  let qrKey: string | null = null;
  let wbi: { img: string; sub: string; until: number } | null = null;
  let navRevision = 0;
  let navInFlight: { generation: number; revision: number; promise: Promise<JsonObject> } | null = null;
  let auth: BiliAuthState = { status: "logged-out", loggedIn: false, user: null, qrDataUrl: null, expiresAt: null, message: "扫码登录后可使用账号已有的播放权限。" };
  const getAuth = () => structuredClone(auth);
  const publish = (patch: Partial<BiliAuthState>) => {
    if (disposed) return;
    auth = { ...auth, ...patch };
    options.onAuth(getAuth());
  };
  let proxyReady: Promise<void> | null = null;
  function prepareProxy(): Promise<void> {
    if (proxyReady) return proxyReady;
    const operation = network.setProxy({ mode: "system" }).then(() => network.forceReloadProxyConfig())
      .catch(() => {
        if (proxyReady === operation) proxyReady = null;
        throw new Error("系统代理配置暂不可用，请检查网络后重试。");
      });
    proxyReady = operation;
    return operation;
  }
  void prepareProxy().catch(() => {});

  function cleanTokens() {
    for (const [token, entry] of media) if (entry.expiresAt <= now()) media.delete(token);
    while (media.size > 400) media.delete(media.keys().next().value!);
  }
  function assetUrl(value: unknown): string | null {
    try { return registerMedia([normalizeBiliMediaUrl(value)], "image", now() + 24 * 60 * 60_000); }
    catch { return null; }
  }
  function registerMedia(urls: string[], kind: MediaEntry["kind"], expiry?: number): string {
    const candidates = [...new Set(urls.map(normalizeBiliMediaUrl))];
    if (!candidates.length) throw new Error("视频没有可用的播放地址。");
    // Prefer regular official CDNs; mcdn peer endpoints can be less reliable.
    candidates.sort((a, b) => {
      const rank = (value: string) => { const host = new URL(value).hostname; return host.startsWith("upos-") ? 0 : host.includes("mcdn") ? 2 : 1; };
      return rank(a) - rank(b);
    });
    const deadlines = candidates.map(value => Number(new URL(value).searchParams.get("deadline")) * SECOND)
      .filter(value => Number.isFinite(value) && value > now());
    const expiresAt = expiry ?? Math.min(now() + 2 * 60 * 60_000, ...(deadlines.length ? deadlines.map(value => value - 30_000) : [Infinity]));
    const token = randomBytes(24).toString("hex");
    cleanTokens();
    media.set(token, { urls: candidates, expiresAt, kind });
    return `touchfish-media://stream/${token}`;
  }
  function trackUrls(track: JsonObject): string[] {
    const values = [track.baseUrl, track.base_url, track.url, ...(Array.isArray(track.backupUrl) ? track.backupUrl : []), ...(Array.isArray(track.backup_url) ? track.backup_url : [])];
    const valid: string[] = [];
    for (const value of values) { try { valid.push(normalizeBiliMediaUrl(value)); } catch { /* An unsafe backup is never followed. */ } }
    return [...new Set(valid)];
  }

  async function fetchResponse(
    url: string,
    settings: { media?: boolean; cookies?: boolean; headers?: Record<string, string>; signal?: AbortSignal; head?: boolean } = {},
  ): Promise<NetworkResponse> {
    const validate = settings.media ? trustedBiliMediaUrl : trustedBiliApiUrl;
    validate(url);
    if (disposed) throw new Error("播放服务已关闭。");
    await prepareProxy();
    const controller = new AbortController();
    requests.add(controller);
    const parentAbort = () => controller.abort();
    settings.signal?.addEventListener("abort", parentAbort, { once: true });
    if (settings.signal?.aborted) controller.abort();
    return new Promise((resolve, reject) => {
      let request: ClientRequest | undefined;
      let incoming: Readable | undefined;
      let settled = false;
      let completed = false;
      let idle: ReturnType<typeof setTimeout> | undefined;
      let redirects = 0;
      const clean = () => {
        if (completed) return;
        completed = true;
        clearTimeout(idle);
        requests.delete(controller);
        controller.signal.removeEventListener("abort", cancel);
        settings.signal?.removeEventListener("abort", parentAbort);
      };
      const fail = (message: string) => {
        if (completed) return;
        if (!settled) { settled = true; reject(new Error(message)); }
        incoming?.destroy(new Error(message));
        clean();
        request?.abort();
      };
      const cancel = () => fail("请求已取消。");
      const reset = () => { clearTimeout(idle); idle = setTimeout(() => fail("连接超时，请检查系统代理或网络后重试。"), settings.media ? 60_000 : timeout); };
      try {
        request = net.request({ url, session: network, method: settings.head ? "HEAD" : "GET", redirect: "manual",
          // Poll credentials are committed only after the current login generation
          // is confirmed; neither a stale poll nor a CDN may set account cookies.
          credentials: settings.media || settings.cookies === false ? "omit" : "include" });
        request.setHeader("User-Agent", userAgent);
        request.setHeader("Referer", REFERER);
        request.setHeader("Origin", "https://www.bilibili.com");
        request.setHeader("Accept", settings.media ? "*/*" : "application/json, text/xml;q=0.9, */*;q=0.8");
        for (const [key, value] of Object.entries(settings.headers ?? {})) request.setHeader(key, value);
        request.on("login", (_info, callback) => { callback(); fail("系统代理需要身份验证，请在系统中完成验证后重试。"); });
        request.on("redirect", (_status, _method, target) => {
          try {
            if (++redirects > 5) throw new Error();
            validate(target);
            // API credentials may not follow an origin-changing redirect.
            if (!settings.media && new URL(target).origin !== new URL(url).origin) throw new Error();
            request!.followRedirect();
          } catch { fail("服务器返回了无法验证的跳转地址。"); }
        });
        request.on("error", () => fail("网络请求失败，请检查系统代理或稍后重试。"));
        request.on("abort", () => { if (!completed) fail("请求已取消。"); });
        request.once("response", response => {
          try {
          reset();
          const cookies = response.headers["set-cookie"];
          incoming = response as unknown as Readable;
          response.on("data", reset);
          response.once("end", clean);
          response.once("error", () => fail("媒体连接中断，请重试播放。"));
          response.once("aborted", () => fail("媒体连接中断，请重试播放。"));
          const headers = new Headers();
          const allowed = settings.media
            ? ["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "etag", "last-modified"]
            : ["content-type", "content-length"];
          for (const name of allowed) {
            const value = response.headers[name];
            if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
          }
          // Chromium has already decoded compressed bodies.
          if (response.headers["content-encoding"]) headers.delete("content-length");
          const noBody = settings.head || [204, 205, 304].includes(response.statusCode);
          const result = new Response(noBody ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status: response.statusCode, headers });
          settled = true;
          resolve({ response: result, cookies: Array.isArray(cookies) ? cookies : cookies ? [cookies] : [] });
          if (noBody) incoming.resume();
          } catch { fail("服务器返回了无法识别的响应。"); }
        });
        controller.signal.addEventListener("abort", cancel, { once: true });
        reset();
        if (controller.signal.aborted) cancel();
        else request.end();
      } catch { fail("无法创建播放请求，请重试。"); }
    });
  }

  async function readBounded(response: Response, maximum: number): Promise<Buffer> {
    const advertised = Number(response.headers.get("content-length"));
    if (Number.isFinite(advertised) && advertised > maximum) { await response.body?.cancel(); throw new Error("服务器返回的数据过大。"); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("服务器没有返回可用数据。");
    const chunks: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    const hard = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, timeout * 2);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maximum) { await reader.cancel(); throw new Error("服务器返回的数据过大。"); }
        chunks.push(Buffer.from(value));
      }
      if (timedOut) throw new Error("连接超时，请重试。");
      return Buffer.concat(chunks);
    } finally { clearTimeout(hard); reader.releaseLock(); }
  }
  async function json(url: string, settings: { cookies?: boolean; signal?: AbortSignal } = {}): Promise<{ data: JsonObject; cookies: string[] }> {
    const result = await fetchResponse(url, settings);
    if (!result.response.ok) { await result.response.body?.cancel(); throw new Error(safeBiliError(result.response.status)); }
    let value: unknown;
    try { value = JSON.parse((await readBounded(result.response, MAX_JSON)).toString("utf8")); }
    catch (error) { throw new Error(error instanceof Error && /超时|过大|取消/.test(error.message) ? error.message : "哔哩哔哩返回的数据无法识别，请重试。"); }
    if (!object(value) || typeof value.code !== "number") throw new Error("哔哩哔哩返回的数据格式不正确。");
    if (value.code !== 0) throw new Error(safeBiliError(value.code));
    if (!object(value.data)) throw new Error("此视频没有可用数据，可能已删除或需要相应观看权限。");
    return { data: value.data, cookies: result.cookies };
  }

  async function nav(forceFresh = false): Promise<JsonObject> {
    if (forceFresh) { navRevision++; navInFlight = null; }
    if (navInFlight && navInFlight.generation === generation && navInFlight.revision === navRevision) return navInFlight.promise;
    const epoch = generation;
    const revision = navRevision;
    const operation = (async () => {
      const response = await fetchResponse(`${API}/x/web-interface/nav`);
      if (!response.response.ok) { await response.response.body?.cancel(); throw new Error(safeBiliError(response.response.status)); }
      let raw: unknown;
      try { raw = JSON.parse((await readBounded(response.response, MAX_JSON)).toString("utf8")); }
      catch { throw new Error("账号信息暂时无法读取，请重试。"); }
      // Anonymous nav replies use -101 but still provide public WBI keys.
      if (!object(raw) || ![0, -101].includes(raw.code) || !object(raw.data)) throw new Error(safeBiliError(object(raw) ? raw.code : -1));
      const data = raw.data;
      if (epoch !== generation || revision !== navRevision || disposed) return data;
      const keys = data.wbi_img;
      if (object(keys)) {
        const extract = (value: unknown) => { try { return /\/([a-f0-9]{32})\.[a-z]+$/i.exec(new URL(String(value)).pathname)?.[1]; } catch { return undefined; } };
        const img = extract(keys.img_url), sub = extract(keys.sub_url);
        if (img && sub) wbi = { img, sub, until: now() + 3_600_000 };
      }
      if (data.isLogin === true && id(data.mid)) {
        publish({ status: "authenticated", loggedIn: true, user: { uid: data.mid, name: text(data.uname, 80) || "哔哩哔哩用户", avatar: assetUrl(data.face) }, qrDataUrl: null, expiresAt: null, message: "已登录，播放使用账号现有权限。" });
      } else if (auth.loggedIn || auth.status === "loading") {
        publish({ status: "logged-out", loggedIn: false, user: null, qrDataUrl: null, expiresAt: null, message: "尚未登录，可扫码后使用账号已有的播放权限。" });
      }
      return data;
    })().finally(() => { if (navInFlight?.promise === operation) navInFlight = null; });
    navInFlight = { generation: epoch, revision, promise: operation };
    return operation;
  }
  async function signedUrl(path: string, params: Record<string, string | number>): Promise<string> {
    if (!wbi || wbi.until <= now()) await nav();
    if (!wbi) throw new Error("播放签名暂未就绪，请重试。");
    return `${API}${path}?${signWbi(params, wbi.img, wbi.sub, now())}`;
  }

  function stopLogin() {
    generation++;
    clearTimeout(pollTimer);
    pollTimer = undefined;
    loginRequest?.abort();
    loginRequest = null;
    qrKey = null;
  }
  function cancelLogin() {
    stopLogin();
    if (!auth.loggedIn) publish({ status: "logged-out", user: null, qrDataUrl: null, expiresAt: null, message: "已取消扫码登录。" });
  }
  async function storeLoginCookies(lines: string[]) {
    const parsed = lines.flatMap(line => {
      const parts = line.split(";").map(value => value.trim());
      const split = parts[0].indexOf("=");
      if (split < 1) return [];
      const name = parts[0].slice(0, split), value = parts[0].slice(split + 1);
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(name) || !value || value.length > 16_384) return [];
      const attrs = new Map(parts.slice(1).map(part => { const at = part.indexOf("="); return [part.slice(0, at < 0 ? undefined : at).toLowerCase(), at < 0 ? "" : part.slice(at + 1)] as const; }));
      const domain = (attrs.get("domain") ?? ".bilibili.com").toLowerCase();
      if (!(domain === "bilibili.com" || domain === ".bilibili.com" || domain === "passport.bilibili.com" || domain === ".passport.bilibili.com")) return [];
      const expires = Date.parse(attrs.get("expires") ?? "");
      const maxAge = Number(attrs.get("max-age"));
      const expirationDate = attrs.has("max-age") && Number.isFinite(maxAge) ? now() / 1000 + maxAge
        : Number.isFinite(expires) ? expires / 1000 : now() / 1000 + 30 * 24 * 60 * 60;
      const cookie: Electron.CookiesSetDetails = { url: domain.includes("passport") ? PASSPORT : REFERER, name, value, domain, path: "/", secure: true, httpOnly: attrs.has("httponly") || name === "SESSDATA", expirationDate, sameSite: "no_restriction" };
      return [cookie];
    });
    if (!parsed.some(cookie => cookie.name === "SESSDATA")) throw new Error("登录凭据未完整返回，请刷新二维码重试。");
    for (const cookie of parsed) await network.cookies.set(cookie);
    await network.cookies.flushStore();
  }
  async function pollLogin(token: number) {
    if (disposed || generation !== token || !qrKey) return;
    if (auth.expiresAt === null || auth.expiresAt <= now()) {
      stopLogin();
      publish({ status: "expired", qrDataUrl: null, expiresAt: null, message: "二维码已过期，请刷新后重新扫码。" });
      return;
    }
    loginRequest = new AbortController();
    try {
      const result = await json(`${PASSPORT}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrKey)}`, { cookies: false, signal: loginRequest.signal });
      if (disposed || token !== generation) return;
      const code = result.data.code;
      if (code === 0) {
        clearTimeout(pollTimer);
        const operation = credentialQueue.then(async () => {
          if (disposed || token !== generation) return;
          await storeLoginCookies(result.cookies);
          if (disposed || token !== generation) return;
          qrKey = null;
          wbi = null;
          await nav(true);
          if (!auth.loggedIn) throw new Error("登录暂未确认，请刷新二维码后重试。");
        });
        credentialQueue = operation.catch(() => {});
        await operation;
        return;
      }
      if (code === 86038) {
        stopLogin();
        publish({ status: "expired", qrDataUrl: null, expiresAt: null, message: "二维码已过期，请刷新后重新扫码。" });
        return;
      }
      if (code === 86090) publish({ status: "scanned", message: "扫码成功，请在哔哩哔哩手机端确认登录。" });
      else if (code === 86101) publish({ status: "qr", message: "请使用哔哩哔哩手机端扫码。" });
      else throw new Error("扫码登录暂时不可用，请刷新二维码重试。");
    } catch (error) {
      if (disposed || token !== generation) return;
      // Keep a valid QR visible on a temporary network interruption.
      publish(qrKey ? { message: error instanceof Error ? error.message : "网络暂不可用，正在等待扫码。" }
        : { status: "error", qrDataUrl: null, expiresAt: null, message: error instanceof Error ? error.message : "登录暂未确认，请重试。" });
    }
    if (!disposed && token === generation && qrKey) pollTimer = setTimeout(() => { void pollLogin(token); }, pollInterval);
  }
  async function createQr(): Promise<BiliAuthState> {
    stopLogin();
    const token = generation;
    publish({ status: "loading", qrDataUrl: null, expiresAt: null, message: "正在生成登录二维码…" });
    loginRequest = new AbortController();
    try {
      await network.forceReloadProxyConfig();
      const { data } = await json(`${PASSPORT}/x/passport-login/web/qrcode/generate`, { cookies: false, signal: loginRequest.signal });
      if (token !== generation || disposed) return getAuth();
      if (typeof data.qrcode_key !== "string" || !/^[A-Za-z0-9_-]{8,256}$/.test(data.qrcode_key) || typeof data.url !== "string") throw new Error("登录二维码数据不完整，请重试。");
      const qrUrl = new URL(data.url);
      if (qrUrl.protocol !== "https:" || qrUrl.username || qrUrl.password || !["passport.bilibili.com", "www.bilibili.com"].includes(qrUrl.hostname)) throw new Error("登录二维码地址无法验证，请重试。");
      const qrDataUrl = await QRCode.toDataURL(qrUrl.toString(), { width: 232, margin: 2, errorCorrectionLevel: "M" });
      if (token !== generation || disposed) return getAuth();
      qrKey = data.qrcode_key;
      publish({ status: "qr", qrDataUrl, expiresAt: now() + 180_000, message: "请使用哔哩哔哩手机端扫码。" });
      pollTimer = setTimeout(() => { void pollLogin(token); }, pollInterval);
    } catch (error) {
      if (!disposed && token === generation) publish({ status: "error", qrDataUrl: null, expiresAt: null, message: error instanceof Error ? error.message : "二维码生成失败，请重试。" });
    }
    return getAuth();
  }
  async function logout(): Promise<BiliAuthState> {
    stopLogin();
    navRevision++;
    navInFlight = null;
    publish({ status: "logged-out", loggedIn: false, user: null, qrDataUrl: null, expiresAt: null, message: "已退出登录。" });
    const operation = credentialQueue.then(async () => {
      await network.clearStorageData({ storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"] });
      await network.clearAuthCache();
      await network.cookies.flushStore();
      wbi = null;
      videoCache.clear();
      media.clear();
    });
    credentialQueue = operation.catch(() => {});
    await operation;
    return getAuth();
  }

  async function getVideo(input: string): Promise<BiliVideo> {
    await credentialQueue;
    const epoch = generation;
    const bvid = normalizeBvid(input);
    const cached = videoCache.get(bvid);
    if (cached && cached.until > now()) return structuredClone(cached.value);
    const { data } = await json(`${API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
    if (disposed || epoch !== generation) throw new Error("账号状态已变化，请重新打开视频。");
    if (data.bvid !== bvid || !Array.isArray(data.pages) || !data.pages.length || data.pages.length > 5000)
      throw new Error("视频信息不完整或没有可播放分 P。");
    const pages = data.pages.map((page: unknown) => {
      if (!object(page) || !id(page.cid) || !id(page.page)) throw new Error("视频分 P 信息不正确。");
      return { cid: page.cid, page: page.page, title: text(page.part, 160) || `第 ${page.page} P`, duration: Number.isFinite(page.duration) ? Math.max(0, page.duration) : 0 };
    });
    const value: BiliVideo = { bvid, title: text(data.title, 500) || bvid, owner: object(data.owner) ? text(data.owner.name, 100) : "", cover: assetUrl(data.pic), duration: Number.isFinite(data.duration) ? Math.max(0, data.duration) : pages.reduce((sum: number, page: { duration: number }) => sum + page.duration, 0), pages };
    if (videoCache.size >= 80) videoCache.delete(videoCache.keys().next().value!);
    videoCache.set(bvid, { value, until: now() + 10 * 60_000 });
    return structuredClone(value);
  }
  async function resolvePlayback(request: BiliPlayRequest): Promise<BiliPlayback> {
    const epoch = generation;
    if (!object(request) || !["audio", "video"].includes(request.mode) || request.cid !== undefined && !id(request.cid) || request.quality !== undefined && (!Number.isInteger(request.quality) || request.quality < 1 || request.quality > 127))
      throw new Error("播放请求不正确。");
    const video = await getVideo(request.bvid);
    const page = request.cid === undefined ? video.pages[0] : video.pages.find(value => value.cid === request.cid);
    if (!page) throw new Error("视频分 P 不存在，请重新选择。");
    const qn = request.quality ?? 80;
    const params = { bvid: video.bvid, cid: page.cid, qn, fnval: request.mode === "audio" ? 16 : 4048, fnver: 0, fourk: 1, platform: "pc", web_location: 1315873, gaia_source: "pre-load", voice_balance: 1 };
    const url = await signedUrl("/x/player/wbi/playurl", params);
    const { data } = await json(url);
    if (disposed || epoch !== generation) throw new Error("账号状态已变化，请重新打开视频。");
    let videoUrl: string | null = null;
    let audioUrl: string | null = null;
    let quality = Number.isInteger(data.quality) ? data.quality : qn;
    let qualities: BiliQuality[] = [];
    if (object(data.dash)) {
      const dash = data.dash;
      const videoTracks = Array.isArray(dash.video) ? dash.video.filter((value: unknown) => object(value) && id(value.id) && (value.codecid === 7 || typeof value.codecs === "string" && /^avc[13]/i.test(value.codecs)) && trackUrls(value).length) as JsonObject[] : [];
      const audioTracks = Array.isArray(dash.audio) ? dash.audio.filter((value: unknown) => object(value) && (value.codecs === undefined || /^mp4a\.40\.(?:2|5|29)$/i.test(String(value.codecs))) && trackUrls(value).length) as JsonObject[] : [];
      audioTracks.sort((a, b) => Number(b.bandwidth ?? 0) - Number(a.bandwidth ?? 0));
      if (audioTracks[0]) audioUrl = registerMedia(trackUrls(audioTracks[0]), "media");
      if (!audioUrl) throw new Error("此视频暂未提供可播放的 AAC 音轨，请稍后重试。");
      const ids = [...new Set(videoTracks.map(value => Number(value.id)))].sort((a, b) => b - a);
      qualities = ids.map(value => ({ id: value, label: QUALITY_NAMES[value] ?? `${value} 画质` }));
      if (request.mode === "video") {
        const selected = videoTracks.find(value => value.id === qn) ?? videoTracks.find(value => value.id === data.quality) ?? videoTracks.sort((a, b) => Number(b.id) - Number(a.id)).find(value => value.id <= qn) ?? videoTracks[0];
        if (!selected) throw new Error("此视频未提供当前播放器支持的 H.264 画面，可以尝试只听声音。");
        quality = selected.id;
        videoUrl = registerMedia(trackUrls(selected), "media");
      }
    } else if (request.mode === "video" && Array.isArray(data.durl) && data.durl.length === 1 && object(data.durl[0])) {
      videoUrl = registerMedia(trackUrls(data.durl[0]), "media");
      qualities = [{ id: quality, label: QUALITY_NAMES[quality] ?? "默认画质" }];
    } else {
      throw new Error(request.mode === "audio" ? "此视频没有可用的独立音轨，请尝试看视频。" : "此视频暂无可播放的视频流，请确认账号观看权限后重试。");
    }
    const urls = [videoUrl, audioUrl].filter((value): value is string => !!value);
    const expiresAt = Math.min(...urls.map(value => media.get(new URL(value).pathname.slice(1))?.expiresAt ?? now() + 60_000));
    return { video, cid: page.cid, mode: request.mode, quality, qualities, videoUrl, audioUrl, expiresAt };
  }
  async function getDanmaku(cid: number): Promise<BiliDanmaku[]> {
    if (!id(cid)) throw new Error("弹幕分 P 编号无效。");
    const known = [...videoCache.values()].some(value => value.value.pages.some(page => page.cid === cid));
    if (!known) throw new Error("请先打开该视频，再读取弹幕。");
    const cached = danmakuCache.get(cid);
    if (cached && cached.until > now()) return structuredClone(cached.value);
    const { response } = await fetchResponse(`${API}/x/v1/dm/list.so?oid=${cid}`);
    if (!response.ok) { await response.body?.cancel(); throw new Error("弹幕暂时不可用，视频仍可继续播放。"); }
    const value = parseDanmakuXml((await readBounded(response, MAX_XML)).toString("utf8"));
    if (danmakuCache.size >= 12) danmakuCache.delete(danmakuCache.keys().next().value!);
    danmakuCache.set(cid, { value, until: now() + 5 * 60_000 });
    return structuredClone(value);
  }

  function registerMediaProtocol(targetSession: Session) {
    if (protocolSessions.has(targetSession)) return;
    targetSession.protocol.handle("touchfish-media", async request => {
      try {
        const parsed = new URL(request.url);
        if (parsed.hostname !== "stream" || parsed.search || parsed.hash || !/^\/[a-f0-9]{48}$/.test(parsed.pathname) || !["GET", "HEAD"].includes(request.method)) return new Response("", { status: 400 });
        const entry = media.get(parsed.pathname.slice(1));
        if (!entry || entry.expiresAt <= now()) return new Response("", { status: 410 });
        const range = request.headers.get("range");
        if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) return new Response("", { status: 416 });
        for (const url of entry.urls) {
          try {
            const { response } = await fetchResponse(url, { media: true, headers: range ? { Range: range } : {}, signal: request.signal, head: request.method === "HEAD" });
            if (![200, 206, 304].includes(response.status)) { await response.body?.cancel(); continue; }
            const headers = new Headers(response.headers);
            headers.set("Access-Control-Allow-Origin", "*");
            headers.set("Cross-Origin-Resource-Policy", "cross-origin");
            headers.set("Cache-Control", "private, max-age=60");
            headers.set("X-Content-Type-Options", "nosniff");
            if (entry.kind === "image" && !/^image\//i.test(headers.get("content-type") ?? "")) {
              await response.body?.cancel();
              continue;
            }
            if (entry.kind === "media") {
              const type = headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
              if (/^(?:audio|video)\//.test(type)) { /* Retain the upstream codec/container MIME. */ }
              else if (["application/octet-stream", "binary/octet-stream", "application/mp4", ""].includes(type)) headers.set("content-type", "video/mp4");
              else { await response.body?.cancel(); continue; }
            }
            return new Response(response.body, { status: response.status, headers });
          } catch { if (request.signal.aborted || disposed) break; }
        }
        return new Response("", { status: 502 });
      } catch { return new Response("", { status: 502 }); }
    });
    protocolSessions.add(targetSession);
  }

  // Restoring an account never delays the main wage panel's startup.
  try {
    const saved = await network.cookies.get({ name: "SESSDATA", domain: ".bilibili.com" });
    if (saved.length) {
      auth = { ...auth, status: "loading", message: "正在恢复登录状态…" };
      const epoch = generation, revision = navRevision;
      void nav().catch(() => {
        if (!disposed && generation === epoch && navRevision === revision && auth.status === "loading")
          publish({ status: "error", message: "暂时无法验证账号，已保留本地登录信息，请联网后重试。" });
      });
    }
  } catch {
    publish({ status: "error", message: "本地登录信息暂时无法读取，可以重试扫码登录。" });
  }

  return {
    getAuth,
    createQr,
    cancelLogin,
    logout,
    getVideo,
    resolvePlayback,
    getDanmaku,
    getSession: () => network,
    registerMediaProtocol,
    async flush() { await credentialQueue; await network.cookies.flushStore(); },
    dispose() {
      if (disposed) return;
      stopLogin();
      disposed = true;
      for (const request of [...requests]) request.abort();
      media.clear();
      for (const target of protocolSessions) target.protocol.unhandle("touchfish-media");
      protocolSessions.clear();
    },
  };
}

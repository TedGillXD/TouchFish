import { app, net, session, type ClientRequest, type Session } from "electron";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installHolidayData, parseHolidayYear } from "../src/holidays";
import type { HolidayState, HolidayYearData } from "../src/holiday-types";

const DAY = 86_400_000;
const MAX_DOCUMENT_BYTES = 256 * 1024;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const SOURCES = [
  "https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/",
  "https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/",
] as const;

type FailureKind = "unpublished" | "network" | "invalid" | "proxy" | "timeout" | "disposed";
class HolidayFailure extends Error {
  constructor(readonly kind: FailureKind) { super(kind); }
}

export interface HolidayServiceOptions {
  onState: (state: HolidayState) => void;
  /** Main-process-only dependencies used by isolated integration tests. */
  networkSession?: Session;
  now?: () => number;
  userData?: string;
  requestTimeoutMs?: number;
}

/** Online CN notices are cached separately from personal payroll records. */
export async function createHolidayService(options: HolidayServiceOptions) {
  const now = options.now ?? Date.now;
  const directory = options.userData ?? app.getPath("userData");
  const path = join(directory, "holiday-cache.json");
  const backup = join(directory, "holiday-cache.backup.json");
  const temporary = join(directory, "holiday-cache.tmp.json");
  const network = options.networkSession ?? session.fromPartition("touchfish-holidays", { cache: false });
  const timeout = Math.max(100, Math.min(options.requestTimeoutMs ?? 10_000, 30_000));
  const requests = new Set<() => void>();
  const pending = new Set<number>();
  const active = new Set<number>();
  const attempted = new Map<number, number>();
  let years = new Map<number, HolidayYearData>();
  let lastChecked: number | null = null;
  let status: HolidayState["status"] = "idle";
  let message = "尚未下载中国大陆节假日安排。";
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | null = null;
  let writeQueue: Promise<void> = Promise.resolve();
  let lastWriteError: Error | null = null;

  const sortedYears = () => [...years.values()].sort((a, b) => a.year - b.year);
  const getState = (): HolidayState => structuredClone({
    status, years: sortedYears(), lastChecked, message, systemProxy: true,
  });
  const publish = () => { if (!disposed) options.onState(getState()); };
  const syncDomain = () => installHolidayData(sortedYears());

  async function readCache(file: string) {
    if ((await stat(file)).size > MAX_CACHE_BYTES) throw new Error("节假日缓存过大。");
    const raw = JSON.parse(await readFile(file, "utf8"));
    if (!raw || raw.version !== 1 || raw.country !== "CN" ||
      !Array.isArray(raw.years) || raw.years.length > 100)
      throw new Error("节假日缓存格式错误。");
    const restored = new Map<number, HolidayYearData>();
    for (const value of raw.years) {
      if (!value || restored.has(value.year)) throw new Error("节假日缓存年份重复。");
      restored.set(value.year, parseHolidayYear(value, value.year, value.fetchedAt, value.source));
    }
    years = restored;
    lastChecked = Number.isFinite(raw.lastChecked) && raw.lastChecked >= 0 ? raw.lastChecked : null;
    for (const value of years.values()) attempted.set(value.year, value.fetchedAt);
    syncDomain();
  }

  try {
    await readCache(path);
    status = years.size ? "ready" : "idle";
    if (years.size) message = "已加载本地中国大陆节假日缓存，联网后自动检查更新。";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      await copyFile(path, join(directory, "holiday-cache.invalid.json")).catch(() => {});
    try {
      await readCache(backup);
      status = years.size ? "ready" : "idle";
      message = "已恢复备用节假日缓存，联网后会重新检查。";
    } catch {
      years = new Map();
      syncDomain();
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        status = "error";
        message = "节假日缓存无法读取，原文件已保留；请联网重新获取。";
      }
    }
  }

  function persist(): Promise<void> {
    const text = JSON.stringify({ version: 1, country: "CN", years: sortedYears(), lastChecked }, null, 2);
    if (Buffer.byteLength(text, "utf8") > MAX_CACHE_BYTES)
      return Promise.reject(new Error("节假日缓存过大，未覆盖本地缓存。"));
    const operation = writeQueue.then(async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flush: true });
      // Recovery always contains this verified complete cache, never bad input.
      await rename(temporary, path);
      await copyFile(path, backup);
      lastWriteError = null;
    });
    writeQueue = operation.catch((error: Error) => { lastWriteError = error; });
    return operation;
  }

  function download(url: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let request: ClientRequest | undefined;
      let done = false;
      const chunks: Buffer[] = [];
      let bytes = 0;
      let idle: ReturnType<typeof setTimeout> | undefined;
      let hard: ReturnType<typeof setTimeout> | undefined;
      const clean = () => {
        clearTimeout(idle);
        clearTimeout(hard);
        requests.delete(cancel);
      };
      const fail = (kind: FailureKind) => {
        if (done) return;
        done = true;
        clean();
        reject(new HolidayFailure(kind));
        request?.abort();
      };
      const cancel = () => fail("disposed");
      const resetIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(() => fail("timeout"), timeout);
      };
      try {
        request = net.request({ url, method: "GET", session: network, redirect: "manual", useSessionCookies: false });
        requests.add(cancel);
        hard = setTimeout(() => fail("timeout"), timeout * 2);
        resetIdle();
        request.setHeader("Accept", "application/json");
        request.setHeader("Cache-Control", "no-cache");
        request.setHeader("User-Agent", `TouchFish/${app.getVersion()}`);
        request.on("login", (_info, callback) => { callback(); fail("proxy"); });
        // Fixed raw/CDN endpoints do not need redirects. Never follow a supplied URL.
        request.on("redirect", () => fail("invalid"));
        request.on("error", () => fail("network"));
        request.on("abort", () => { if (!done) fail("network"); });
        request.once("response", (response) => {
          if (response.statusCode !== 200) {
            fail(response.statusCode === 404 ? "unpublished" : response.statusCode === 407 ? "proxy" : "network");
            return;
          }
          const advertised = Number(response.headers["content-length"]);
          if (Number.isFinite(advertised) && advertised > MAX_DOCUMENT_BYTES) { fail("invalid"); return; }
          response.on("data", (chunk: Buffer) => {
            if (done) return;
            resetIdle();
            const buffer = Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > MAX_DOCUMENT_BYTES) { fail("invalid"); return; }
            chunks.push(buffer);
          });
          response.once("error", () => fail("network"));
          response.once("aborted", () => fail("network"));
          response.once("end", () => {
            if (done) return;
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              done = true;
              clean();
              resolve(value);
            } catch { fail("invalid"); }
          });
        });
        if (disposed) cancel();
        else request.end();
      } catch { fail("network"); }
    });
  }

  async function fetchYear(year: number): Promise<HolidayYearData> {
    let failure: HolidayFailure = new HolidayFailure("network");
    for (const prefix of SOURCES) {
      if (disposed) throw new HolidayFailure("disposed");
      const source = `${prefix}${year}.json`;
      try {
        const raw = await download(source);
        try { return parseHolidayYear(raw, year, now(), source); }
        catch (error) {
          throw new HolidayFailure(error instanceof Error && error.message.includes("尚未公布") ? "unpublished" : "invalid");
        }
      } catch (error) {
        const next = error instanceof HolidayFailure ? error : new HolidayFailure("network");
        // Keep authentication/validation failure visible even if a mirror is missing.
        if (failure.kind === "network" || next.kind !== "unpublished") failure = next;
      }
    }
    throw failure;
  }

  function defaultYears(): number[] {
    const year = new Date(now()).getFullYear();
    return [...new Set([year - 1, year, year + 1,
      ...[...years.keys()].filter((value) => value >= year - 5 && value <= year + 2),
    ])].filter((value) => value >= 1900 && value <= 2299);
  }

  async function drain(): Promise<void> {
    const failures = new Map<number, FailureKind>();
    while (pending.size && !disposed) {
      const batch = [...pending].slice(0, 8);
      for (const year of batch) { pending.delete(year); active.add(year); attempted.set(year, now()); }
      status = "refreshing";
      message = `正在获取中国大陆 ${batch.join("、")} 年节假日安排…`;
      publish();
      try {
        await network.setProxy({ mode: "system" });
        await network.forceReloadProxyConfig();
        await network.closeAllConnections();
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(2, batch.length) }, async () => {
          while (cursor < batch.length && !disposed) {
            const year = batch[cursor++];
            try {
              const value = await fetchYear(year);
              if (!disposed) years.set(year, value);
            } catch (error) {
              failures.set(year, error instanceof HolidayFailure ? error.kind : "network");
            } finally { active.delete(year); }
          }
        }));
      } catch {
        for (const year of batch) { failures.set(year, "network"); active.delete(year); }
      }
    }
    if (disposed) return;
    lastChecked = now();
    // Keep a bounded cache while retaining recently consulted historical years.
    if (years.size > 100) years = new Map([...years].sort((a, b) => b[1].fetchedAt - a[1].fetchedAt).slice(0, 100));
    syncDomain();
    const unpublished = [...failures].filter(([, kind]) => kind === "unpublished").map(([year]) => year);
    const errors = [...failures].filter(([, kind]) => kind !== "unpublished").map(([year]) => year);
    // An unpublished future year is expected; coverage stays incomplete without
    // making an already usable current-year cache look like a network failure.
    status = errors.length ? "error" : years.size ? "ready" : "idle";
    message = failures.size
      ? [errors.length ? `${errors.join("、")} 年获取失败，请检查网络或系统代理后重试。` : "",
        unpublished.length ? `${unpublished.join("、")} 年安排尚未公布或数据源暂未收录。` : "",
        years.size ? "已下载的缓存仍可使用。" : "暂无缓存，日历暂按工作制度与手动调整估算。"].filter(Boolean).join(" ")
      : `中国大陆节假日已更新，已缓存 ${[...years.keys()].sort((a, b) => a - b).join("、")} 年。`;
    try { await persist(); }
    catch {
      status = "error";
      message = "节假日已获取，但本地缓存保存失败；本次会话可用，请检查磁盘空间后重试。";
    }
    publish();
  }

  async function refresh(requested?: number[], force = false): Promise<HolidayState> {
    if (disposed) return getState();
    const list = requested ?? defaultYears();
    if (!Array.isArray(list) || list.length > 8 || list.some((value) => !Number.isInteger(value) || value < 1900 || value > 2299) || typeof force !== "boolean")
      throw new Error("节假日查询年份无效。");
    const timestamp = now();
    for (const year of new Set(list)) {
      const checked = attempted.get(year);
      if (!active.has(year) && (force || checked === undefined || timestamp - checked >= DAY || timestamp < checked)) pending.add(year);
    }
    // Assign the shared promise before publishing any state, so even a
    // reentrant observer cannot start a second drain on the same Session.
    if (!running && pending.size) running = Promise.resolve().then(drain).finally(() => { running = null; });
    if (running) await running;
    // Requests arriving just as a prior batch settles still get their own turn.
    if (pending.size && !disposed) return refresh([], false);
    return getState();
  }

  return {
    getState,
    refresh,
    start() {
      if (disposed || timer || process.env.TOUCHFISH_HOLIDAYS_AUTO_REFRESH === "0") return;
      void refresh().catch(() => {});
      timer = setInterval(() => { void refresh().catch(() => {}); }, 60 * 60 * 1000);
      timer.unref();
    },
    async flush() {
      // Quitting must not wait on an optional network request. Save any already
      // verified partial result; dispose() cancels outstanding downloads.
      if (running && years.size) await persist();
      await writeQueue;
      if (lastWriteError) throw new Error("节假日缓存保存失败，请重试更新。");
    },
    dispose() {
      disposed = true;
      clearInterval(timer);
      pending.clear();
      for (const cancel of [...requests]) cancel();
    },
  };
}

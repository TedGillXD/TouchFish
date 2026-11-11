import { app, net, shell, type ClientRequest, type Session } from "electron";
import { autoUpdater, type AppUpdater } from "electron-updater";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { UpdateState } from "../src/update-types";
import {
  chooseReleaseFile,
  isNewerVersion,
  LATEST_RELEASE_API,
  parseManifest,
  parseRelease,
  RELEASES_URL,
  safeUpdateError,
  trustedUpdateUrl,
  type ReleaseFile,
  type ReleaseTarget,
} from "./update-policy";

export interface UpdaterOptions {
  onState: (state: UpdateState) => void;
  beforeInstall: () => Promise<void>;
  quitForManualInstall: () => void;
  /** Main-process-only dependencies also let the proxy smoke test avoid changing OS settings. */
  networkSession?: Session;
  openInstaller?: (path: string) => Promise<string>;
  currentVersion?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  packaged?: boolean;
  portable?: boolean;
}

type InternalExecutor = {
  cachedSession: Session | null;
  createRequest: (...args: any[]) => ClientRequest;
};

export function createUpdaterController(options: UpdaterOptions) {
  const updater: AppUpdater = autoUpdater;
  const network = options.networkSession ?? updater.netSession;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const packaged = options.packaged ?? app.isPackaged;
  const portable =
    options.portable ??
    Boolean(
      process.env.PORTABLE_EXECUTABLE_FILE ||
      process.env.PORTABLE_EXECUTABLE_DIR,
    );
  const automatic =
    packaged &&
    ((platform === "win32" && !portable) ||
      (platform === "linux" && Boolean(process.env.APPIMAGE)));
  const openInstaller = options.openInstaller ?? shell.openPath;
  const requests = new Set<ClientRequest>();
  const aborters = new Set<AbortController>();
  let disposed = false;
  let busy = false;
  let proxyAuthDenied = false;
  let target: ReleaseTarget | null = null;
  let asset: ReleaseFile | null = null;
  let downloadedPath: string | null = null;
  let state: UpdateState = {
    currentVersion: options.currentVersion ?? app.getVersion(),
    latestVersion: null,
    status: "idle",
    mode: automatic ? "automatic" : "installer",
    systemProxy: true,
    message: "更新检查和下载跟随系统代理（支持 PAC）。",
    progress: 0,
    transferred: 0,
    total: 0,
    releaseUrl: RELEASES_URL,
    installLabel: automatic
      ? "重启并安装"
      : platform === "darwin"
        ? "打开安装镜像并退出"
        : platform === "linux"
          ? "打开下载文件夹并退出"
          : "打开安装包并退出",
  };
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableDifferentialDownload = true;
  updater.disableWebInstaller = true;
  // Native provider errors can contain signed redirect URLs; only our fixed, safe messages enter the UI.
  updater.logger = null;

  function emit(patch: Partial<UpdateState>): UpdateState {
    state = { ...state, ...patch };
    if (!disposed) {
      try {
        options.onState({ ...state });
      } catch {
        /* A closing renderer cannot interrupt updates. */
      }
    }
    return { ...state };
  }
  const timeoutError = () =>
    Object.assign(new Error("ERR_UPDATE_TIMEOUT"), {
      code: "ERR_UPDATE_TIMEOUT",
    });
  function stopRequest(request: ClientRequest, error: Error) {
    if (request.listenerCount("error")) request.emit("error", error);
    request.abort();
  }
  function abortNetwork() {
    for (const controller of aborters) controller.abort(timeoutError());
    for (const request of [...requests]) stopRequest(request, timeoutError());
  }
  async function deadline<T>(
    promise: Promise<T>,
    milliseconds: number,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => {
            abortNetwork();
            reject(timeoutError());
          }, milliseconds);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // electron-updater 6.8.11 uses net.request on this exact partition. Its Node socket
  // timeout never starts for Electron requests, so add an abortable idle timeout here.
  const executor = (updater as unknown as { httpExecutor: InternalExecutor })
    .httpExecutor;
  const originalCreateRequest = executor?.createRequest;
  if (executor && originalCreateRequest) {
    executor.cachedSession = network;
    executor.createRequest = function (...args: any[]) {
      const requestOptions = args[0];
      const host =
        requestOptions.host ??
        `${requestOptions.hostname}${requestOptions.port ? `:${requestOptions.port}` : ""}`;
      trustedUpdateUrl(
        `${requestOptions.protocol}//${host}${requestOptions.path || "/"}`,
      );
      const request = originalCreateRequest.apply(this, args);
      requests.add(request);
      let timer: ReturnType<typeof setTimeout>;
      const clean = () => {
        clearTimeout(timer);
        requests.delete(request);
      };
      const reset = () => {
        clearTimeout(timer);
        timer = setTimeout(() => stopRequest(request, timeoutError()), 60000);
      };
      request.on("response", (response) => {
        reset();
        response.on("data", reset);
        response.once("end", clean);
        response.once("error", clean);
        response.once("aborted", clean);
      });
      request.on("redirect", reset);
      request.once("error", clean);
      request.once("abort", clean);
      request.once("close", clean);
      reset();
      return request;
    };
  }
  let installationError: Error | null = null;
  const nativeError = (error: Error) => {
    if (state.status === "installing") {
      installationError = error;
      emit({
        status: "error",
        message: safeUpdateError(error, "install", proxyAuthDenied),
      });
    }
  };
  const nativeLogin = (
    _info: Electron.AuthInfo,
    callback: (username: string, password: string) => void,
  ) => {
    proxyAuthDenied = true;
    (callback as (username?: string, password?: string) => void)();
    abortNetwork();
  };
  const nativeProgress = (info: {
    percent: number;
    transferred: number;
    total: number;
  }) => {
    if (!disposed && busy && state.status === "downloading")
      emit({
        progress: Math.max(0, Math.min(100, info.percent)),
        transferred: info.transferred,
        total: info.total,
      });
  };
  updater.on("error", nativeError);
  updater.on("login", nativeLogin);
  updater.on("download-progress", nativeProgress);

  async function prepareProxy() {
    proxyAuthDenied = false;
    await network.setProxy({ mode: "system" });
    await network.forceReloadProxyConfig();
    await network.closeAllConnections();
  }

  async function fetchTrusted(
    url: string,
    signal: AbortSignal,
  ): Promise<Response> {
    trustedUpdateUrl(url);
    return new Promise<Response>((resolve, reject) => {
      const request = net.request({
        url,
        method: "GET",
        session: network,
        redirect: "manual",
        useSessionCookies: false,
      });
      requests.add(request);
      let incoming: Readable | undefined;
      let redirects = 0;
      const cleanup = () => {
        requests.delete(request);
        signal.removeEventListener("abort", cancel);
      };
      const fail = (error: Error) => {
        incoming?.destroy(error);
        reject(error);
        cleanup();
      };
      const cancel = () => {
        const error =
          signal.reason instanceof Error ? signal.reason : timeoutError();
        fail(error);
        request.abort();
      };
      signal.addEventListener("abort", cancel, { once: true });
      request.setHeader("Accept", "application/octet-stream, application/json");
      request.setHeader("User-Agent", `TouchFish/${state.currentVersion}`);
      request.on("login", (_authInfo, callback) => {
        proxyAuthDenied = true;
        callback();
        fail(new Error("PROXY_AUTH_REQUIRED"));
        request.abort();
      });
      request.on("redirect", (_status, _method, location) => {
        try {
          if (++redirects > 8) throw new Error("INVALID_RELEASE");
          trustedUpdateUrl(location);
          request.followRedirect();
        } catch (error) {
          fail(
            error instanceof Error ? error : new Error("UNTRUSTED_UPDATE_URL"),
          );
          request.abort();
        }
      });
      request.on("error", fail);
      request.once("response", (response) => {
        if (response.statusCode !== 200) {
          fail(new Error(`HTTP_${response.statusCode}`));
          request.abort();
          return;
        }
        // Electron IncomingMessage implements Node's Readable stream interface.
        // Converting it preserves backpressure while giving the downloader a web reader.
        incoming = response as unknown as Readable;
        response.once("end", cleanup);
        response.once("error", fail);
        response.once("aborted", () => fail(new Error("UPDATE_ABORTED")));
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers))
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        resolve(
          new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
            status: response.statusCode,
            headers,
          }),
        );
      });
      if (signal.aborted) cancel();
      else request.end();
    });
  }

  async function readJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    aborters.add(controller);
    const timer = setTimeout(() => controller.abort(timeoutError()), 30000);
    try {
      const response = await fetchTrusted(url, controller.signal);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("INVALID_RELEASE");
      const parts: Buffer[] = [];
      let length = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 2 * 1024 ** 2) {
            await reader.cancel();
            throw new Error("INVALID_RELEASE");
          }
          parts.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      return JSON.parse(Buffer.concat(parts).toString("utf8"));
    } finally {
      clearTimeout(timer);
      aborters.delete(controller);
    }
  }

  async function verifyFile(path: string, expected: ReleaseFile) {
    if ((await stat(path)).size !== expected.size)
      throw new Error("HASH_MISMATCH");
    const sha256 = createHash("sha256"),
      sha512 = createHash("sha512");
    for await (const chunk of createReadStream(path)) {
      sha256.update(chunk);
      sha512.update(chunk);
    }
    if (
      sha256.digest("hex") !== expected.sha256 ||
      sha512.digest("base64") !== expected.sha512
    )
      throw new Error("HASH_MISMATCH");
  }

  async function downloadInstaller(
    release: ReleaseTarget,
    file: ReleaseFile,
  ): Promise<string> {
    const directory = join(app.getPath("userData"), "updates", release.version);
    await mkdir(directory, { recursive: true });
    const destination = join(directory, file.name),
      temporary = `${destination}.part`;
    await rm(temporary, { force: true });
    const controller = new AbortController();
    aborters.add(controller);
    let idleTimer: ReturnType<typeof setTimeout>;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(timeoutError()), 60000);
    };
    const hardTimer = setTimeout(
      () => controller.abort(timeoutError()),
      30 * 60 * 1000,
    );
    const sha256 = createHash("sha256"),
      sha512 = createHash("sha512");
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let length = 0,
      lastProgress = 0;
    try {
      resetIdle();
      const response = await fetchTrusted(
        `${release.downloadBase}${encodeURIComponent(file.name)}`,
        controller.signal,
      );
      const reader = response.body?.getReader();
      if (!reader) throw new Error("INVALID_RELEASE");
      handle = await open(temporary, "wx", 0o600);
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          resetIdle();
          length += value.byteLength;
          if (length > file.size) {
            await reader.cancel();
            throw new Error("HASH_MISMATCH");
          }
          sha256.update(value);
          sha512.update(value);
          await handle.writeFile(value);
          if (Date.now() - lastProgress >= 150) {
            lastProgress = Date.now();
            emit({
              progress: (length / file.size) * 100,
              transferred: length,
              total: file.size,
            });
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (
        length !== file.size ||
        sha256.digest("hex") !== file.sha256 ||
        sha512.digest("base64") !== file.sha512
      )
        throw new Error("HASH_MISMATCH");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rm(destination, { force: true });
      await rename(temporary, destination);
      if (platform === "linux") await chmod(destination, 0o755);
      return destination;
    } catch (error) {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    } finally {
      clearTimeout(idleTimer!);
      clearTimeout(hardTimer);
      aborters.delete(controller);
    }
  }

  return {
    getState: (): UpdateState => ({ ...state }),
    async check(): Promise<UpdateState> {
      if (busy || disposed) return { ...state };
      busy = true;
      target = null;
      asset = null;
      downloadedPath = null;
      emit({
        status: "checking",
        latestVersion: null,
        progress: 0,
        transferred: 0,
        total: 0,
        message: "正在通过系统代理检查更新…",
      });
      try {
        await deadline(prepareProxy(), 15000);
        const release = parseRelease(
          await deadline(readJson(LATEST_RELEASE_API), 45000),
        );
        if (!isNewerVersion(release.version, state.currentVersion))
          return emit({
            status: "not-available",
            latestVersion: release.version,
            releaseUrl: release.releaseUrl,
            message: "当前已是最新正式版本。",
          });
        const manifest = parseManifest(
          await readJson(`${release.downloadBase}release-manifest.json`),
          release.version,
        );
        const file = chooseReleaseFile(manifest, platform, arch);
        if (!file) throw new Error("UNSUPPORTED_ASSET");
        if (automatic) {
          updater.setFeedURL({
            provider: "generic",
            url: release.downloadBase,
            useMultipleRangeRequest: false,
          });
          const result = await deadline(updater.checkForUpdates(), 45000);
          if (!result || result.updateInfo.version !== release.version)
            throw new Error("INVALID_RELEASE");
        }
        target = release;
        asset = file;
        return emit({
          status: "available",
          latestVersion: release.version,
          releaseUrl: release.releaseUrl,
          total: file.size,
          message: automatic
            ? "发现新版本，可下载后重启安装。"
            : platform === "darwin"
              ? "发现新版本。下载校验后打开安装镜像，将新版拖入应用程序。"
              : platform === "linux"
                ? "发现新版本。下载校验后打开文件夹，替换旧版 AppImage。"
                : "发现新版本。下载校验后打开安装程序完成更新。",
        });
      } catch (error) {
        return emit({
          status: "error",
          message: safeUpdateError(error, "check", proxyAuthDenied),
        });
      } finally {
        busy = false;
      }
    },
    async download(): Promise<UpdateState> {
      if (busy || disposed) return { ...state };
      if (!target || !asset)
        return emit({ status: "error", message: "请先检查更新。" });
      busy = true;
      downloadedPath = null;
      emit({
        status: "downloading",
        progress: 0,
        transferred: 0,
        total: asset.size,
        message: "正在通过系统代理下载并校验更新…",
      });
      try {
        await deadline(prepareProxy(), 15000);
        const path = automatic
          ? (await deadline(updater.downloadUpdate(), 30 * 60 * 1000))[0]
          : await downloadInstaller(target, asset);
        if (!path) throw new Error("HASH_MISMATCH");
        await verifyFile(path, asset);
        downloadedPath = path;
        return emit({
          status: "downloaded",
          progress: 100,
          transferred: asset.size,
          total: asset.size,
          message: automatic
            ? "更新已下载并通过校验，可重启安装。"
            : "更新已下载并通过校验，安装前将先保存工作记录。",
        });
      } catch (error) {
        return emit({
          status: "error",
          message: safeUpdateError(error, "download", proxyAuthDenied),
        });
      } finally {
        busy = false;
      }
    },
    async install(): Promise<void> {
      if (
        busy ||
        disposed ||
        state.status !== "downloaded" ||
        !downloadedPath ||
        !asset
      )
        throw new Error("请先下载并校验更新。");
      busy = true;
      try {
        if (!packaged) throw new Error("开发模式不能安装更新");
        await verifyFile(downloadedPath, asset);
        try {
          await options.beforeInstall();
        } catch {
          throw new Error("SAVE_FAILED");
        }
        emit({
          status: "installing",
          message: automatic
            ? "正在退出并安装更新…"
            : "正在打开已校验的更新安装包…",
        });
        if (automatic) {
          installationError = null;
          updater.quitAndInstall(false, true);
          if (installationError) throw installationError;
        } else {
          if (platform === "linux") shell.showItemInFolder(downloadedPath);
          else {
            const error = await openInstaller(downloadedPath);
            if (error) throw new Error("OPEN_INSTALLER_FAILED");
          }
          options.quitForManualInstall();
        }
      } catch (error) {
        const message = safeUpdateError(error, "install", proxyAuthDenied);
        emit({ status: "error", message });
        throw new Error(message);
      } finally {
        busy = false;
      }
    },
    async openReleasePage(): Promise<void> {
      await shell.openExternal(state.releaseUrl);
    },
    dispose() {
      disposed = true;
      abortNetwork();
      updater.off("error", nativeError);
      updater.off("login", nativeLogin);
      updater.off("download-progress", nativeProgress);
      if (executor && originalCreateRequest)
        executor.createRequest = originalCreateRequest;
    },
  };
}

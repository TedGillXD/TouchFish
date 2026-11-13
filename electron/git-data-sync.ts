import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GitSyncConfig, GitSyncState } from "../src/data-management-types";
import { GIT_BACKUP_PATH, normalizeGitSyncConfig } from "./git-sync-policy";

interface GitResult { code: number; stdout: Buffer; stderr: string }
interface RunOptions { cwd: string; env: NodeJS.ProcessEnv; input?: Buffer | string; limit?: number; timeout?: number; signal?: AbortSignal }
interface GitOptions {
  directory: string;
  onState: (state: GitSyncState) => void;
  maxBytes?: number;
  validateBackup?: (text: string) => void;
  /** Trusted test seam. Renderer input can never select a local transport. */
  testRemote?: (config: GitSyncConfig) => string;
  timeoutMs?: number;
}

class SyncError extends Error {}
const ERROR_GIT = "未找到 Git，请先安装 Git 后重试。";
const ERROR_ACCESS = "无法访问仓库，请确认地址和权限，并先在系统 Git 中完成登录或 SSH 首次连接。";
const ERROR_CONFLICT = "云端分支已变化，未覆盖任何云端数据；请重新检查后选择上传或下载。";
const ERROR_BACKUP = "云端同名文件不是有效的摸鱼时钟备份，未允许覆盖。";
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const oid = (value: string) => /^[a-f0-9]{40}$/.test(value);

/** A bounded child process. No shell, terminal prompt, or visible helper window. */
export function runGitProcess(binary: string, args: string[], options: RunOptions): Promise<GitResult> {
  return new Promise((resolveResult, reject) => {
    if (options.signal?.aborted) { reject(new SyncError("Git 操作已取消。")); return; }
    const child = spawn(binary, args, { cwd: options.cwd, env: options.env, windowsHide: true,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const output: Buffer[] = [], errors: Buffer[] = [];
    let bytes = 0, errorBytes = 0, stopped: SyncError | null = null, settled = false;
    let killFallback: ReturnType<typeof setTimeout> | undefined;
    const stop = (reason: SyncError) => {
      if (stopped || settled) return;
      stopped = reason;
      if (child.pid && child.exitCode === null) {
        if (process.platform === "win32") {
          // The PID comes only from our own child. Kill its SSH/HTTPS helpers too.
          const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.once("error", () => child.kill());
          killer.once("close", () => child.kill());
        } else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill(); } }
      }
      // On Windows the tree terminator may need a few seconds to start (for
      // example under antivirus scanning). Prefer the real child close event
      // over reporting cancellation while helpers still hold the cache open.
      killFallback = setTimeout(() => { child.kill(); finishError(reason); }, 8000);
    };
    const abort = () => stop(new SyncError("Git 操作已取消。"));
    const timer = setTimeout(() => stop(new SyncError("Git 连接超时，请检查 Git 的网络、代理和仓库认证后重试。")), options.timeout ?? 45_000);
    const cleanup = () => { clearTimeout(timer); clearTimeout(killFallback); options.signal?.removeEventListener("abort", abort); };
    const finishError = (error: Error) => { if (settled) return; settled = true; cleanup(); reject(error); };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", error => finishError(new SyncError((error as NodeJS.ErrnoException).code === "ENOENT" ? ERROR_GIT : "Git 暂时无法启动，请稍后重试。")));
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.limit ?? 128 * 1024)) stop(new SyncError("Git 返回的数据过大，操作已停止。"));
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes > 256 * 1024) stop(new SyncError("Git 返回的信息过大，操作已停止。"));
      else errors.push(chunk);
    });
    child.stdin.on("error", () => {});
    child.once("close", code => {
      if (settled) return;
      if (stopped) { finishError(stopped); return; }
      settled = true; cleanup();
      resolveResult({ code: code ?? -1, stdout: Buffer.concat(output), stderr: Buffer.concat(errors).toString("utf8") });
    });
    child.stdin.end(options.input);
  });
}

function gitEnvironment(index: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const transport = new Set(["GIT_SSL_CAINFO", "GIT_SSL_CAPATH", "GIT_SSL_CERT", "GIT_SSL_KEY", "GIT_HTTP_USER_AGENT"]);
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key) && !transport.has(key.toUpperCase())) delete env[key];
  return { ...env, GIT_INDEX_FILE: index, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never",
    GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oStrictHostKeyChecking=yes",
    GIT_AUTHOR_NAME: "TouchFish Backup", GIT_AUTHOR_EMAIL: "backup@touchfish.local",
    GIT_COMMITTER_NAME: "TouchFish Backup", GIT_COMMITTER_EMAIL: "backup@touchfish.local" };
}

/** Manually synchronize one backup file without checking out remote code. */
export async function createGitDataSync(options: GitOptions) {
  const directory = resolve(options.directory), configPath = join(directory, "git-sync.json");
  const cacheRoot = join(directory, "git-sync-cache"), hooks = join(cacheRoot, "empty-hooks");
  const maxBytes = Math.max(1024, Math.min(options.maxBytes ?? 16 * 1024 * 1024, 64 * 1024 * 1024));
  const timeout = Math.max(100, Math.min(options.timeoutMs ?? 45_000, 120_000));
  let state: GitSyncState = { config: null, gitAvailable: null, busy: false, remote: null, lastCheckedAt: null, lastSyncedAt: null, error: null };
  let disposed = false, observed = false;
  let currentAbort: AbortController | null = null;
  let operationId = "", indexes = new Set<string>();
  let active: Promise<void> = Promise.resolve();
  const getState = (): GitSyncState => ({ ...state, config: state.config ? { ...state.config } : null, remote: state.remote ? { ...state.remote } : null });
  const publish = () => { if (!disposed) { try { options.onState(getState()); } catch { /* Reopened panels read a snapshot. */ } } };
  const assertOpen = () => { if (disposed) throw new SyncError("Git 同步服务已关闭。"); };
  const configured = () => { if (!state.config) throw new SyncError("请先保存个人 Git 仓库地址。" ); return { ...state.config }; };
  const cache = (config: GitSyncConfig) => join(cacheRoot, `${createHash("sha256").update(JSON.stringify(config)).digest("hex")}.git`);
  const remote = (config: GitSyncConfig) => options.testRemote?.(config) ?? config.repository;
  function localError(cause: unknown): SyncError {
    if (cause instanceof SyncError) return cause;
    return new SyncError("Git 同步未完成，请检查仓库设置后重试。");
  }
  async function operation<T>(action: () => Promise<T>): Promise<T> {
    assertOpen();
    if (state.busy) throw new SyncError("Git 正在处理另一个操作，请稍后重试。");
    state = { ...state, busy: true, error: null }; currentAbort = new AbortController();
    operationId = randomUUID(); indexes = new Set(); publish();
    const pending = (async () => {
      try { return await action(); }
      catch (cause) {
        const error = localError(cause); observed = false;
        state = { ...state, error: error.message, remote: null, lastCheckedAt: null }; throw error;
      }
      finally {
        // Per-operation indexes cannot inherit a stale index.lock after a crash
        // or cancellation. These generated files are wholly inside our cache.
        await Promise.all([...indexes].flatMap(path => [rm(path, { force: true }).catch(() => {}), rm(`${path}.lock`, { force: true }).catch(() => {})]));
        state = { ...state, busy: false }; currentAbort = null; publish();
      }
    })();
    active = pending.then(() => {}, () => {});
    return pending;
  }
  async function git(config: GitSyncConfig, args: string[], patch: { input?: string | Buffer; limit?: number; outside?: boolean } = {}) {
    assertOpen();
    const repo = cache(config);
    await mkdir(repo, { recursive: true, mode: 0o700 });
    await mkdir(hooks, { recursive: true, mode: 0o700 });
    const flags = ["-c", `core.hooksPath=${hooks}`, "-c", "core.fsmonitor=false", "-c", "credential.interactive=false",
      "-c", `protocol.file.allow=${options.testRemote ? "always" : "never"}`, "-c", "protocol.ext.allow=never", "-c", "fetch.recurseSubmodules=false",
      "-c", "submodule.recurse=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "commit.gpgSign=false"];
    const index = join(repo, `touchfish-index-${operationId}`); indexes.add(index);
    return runGitProcess("git", [...flags, ...(patch.outside ? [] : ["--git-dir", repo]), ...args], {
      cwd: directory, env: gitEnvironment(index), input: patch.input, limit: patch.limit,
      timeout, signal: currentAbort?.signal,
    });
  }
  async function requireGit(config: GitSyncConfig) {
    try {
      const version = await git(config, ["--version"], { outside: true });
      if (version.code !== 0) throw new SyncError(ERROR_GIT);
      state = { ...state, gitAvailable: true };
      const repo = cache(config);
      if (!existsSync(join(repo, "HEAD"))) {
        const init = await git(config, ["init", "--bare", "--template=", "--object-format=sha1", repo], { outside: true });
        if (init.code !== 0) throw new SyncError("Git 缓存无法创建，请检查应用数据目录权限。" );
      }
    } catch (cause) {
      if (cause instanceof SyncError && cause.message === ERROR_GIT) state = { ...state, gitAvailable: false };
      throw cause;
    }
  }
  async function head(config: GitSyncConfig): Promise<string | null> {
    const ref = `refs/heads/${config.branch}`;
    const result = await git(config, ["ls-remote", "--exit-code", "--heads", "--", remote(config), ref]);
    if (result.code === 2 && !result.stdout.length) return null;
    if (result.code !== 0) throw new SyncError(ERROR_ACCESS);
    const lines = result.stdout.toString("utf8").trim().split(/\r?\n/);
    const match = lines.length === 1 ? /^([a-f0-9]{40})\t(.+)$/.exec(lines[0]) : null;
    if (!match || match[2] !== ref) throw new SyncError("Git 返回的分支信息无法识别。" );
    return match[1];
  }
  function validate(text: string) {
    if (Buffer.byteLength(text) > maxBytes) throw new SyncError("备份文件过大，未上传或恢复。" );
    try {
      if (options.validateBackup) options.validateBackup(text);
      else if (!plain(JSON.parse(text))) throw new Error("Not an object");
    } catch { throw new SyncError(ERROR_BACKUP); }
  }
  async function readRemote(config: GitSyncConfig): Promise<{ remote: NonNullable<GitSyncState["remote"]>; text: string | null }> {
    const before = await head(config);
    if (!before) return { remote: { commit: null, fileExists: false, bytes: 0 }, text: null };
    const fetched = await git(config, ["fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "--", remote(config), `+refs/heads/${config.branch}:refs/touchfish/remote`]);
    if (fetched.code !== 0) throw new SyncError(ERROR_ACCESS);
    const revision = await git(config, ["rev-parse", "--verify", "refs/touchfish/remote"]);
    const commit = revision.stdout.toString("utf8").trim();
    if (revision.code !== 0 || !oid(commit)) throw new SyncError("Git 分支读取失败。" );
    const listed = await git(config, ["ls-tree", "-z", commit, "--", GIT_BACKUP_PATH]);
    if (listed.code !== 0) throw new SyncError("Git 文件列表读取失败。" );
    if (!listed.stdout.length) return { remote: { commit, fileExists: false, bytes: 0 }, text: null };
    const entry = /^(100644|100755) blob ([a-f0-9]{40})\ttouchfish-backup\.json\0$/.exec(listed.stdout.toString("utf8"));
    if (!entry) throw new SyncError(ERROR_BACKUP);
    const size = await git(config, ["cat-file", "-s", entry[2]]);
    const bytes = Number(size.stdout.toString("utf8").trim());
    if (size.code !== 0 || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > maxBytes) throw new SyncError("云端备份文件过大或无法读取，未允许覆盖。" );
    const content = await git(config, ["cat-file", "blob", entry[2]], { limit: maxBytes });
    if (content.code !== 0 || content.stdout.length !== bytes) throw new SyncError("云端备份读取失败。" );
    const text = content.stdout.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(content.stdout)) throw new SyncError(ERROR_BACKUP);
    validate(text);
    return { remote: { commit, fileExists: true, bytes }, text };
  }
  async function checkedRemote(config: GitSyncConfig) {
    if (!observed || !state.remote) throw new SyncError("请先检查云端仓库，再选择上传或下载。" );
    const expected = state.remote.commit;
    const found = await readRemote(config);
    if (found.remote.commit !== expected) {
      observed = false; state = { ...state, remote: found.remote, lastCheckedAt: null };
      throw new SyncError(ERROR_CONFLICT);
    }
    return found;
  }
  try {
    if ((await stat(configPath)).size > 16_384) throw new Error("Config too large");
    const raw: unknown = JSON.parse(await readFile(configPath, "utf8"));
    if (!plain(raw) || raw.version !== 1) throw new Error("Invalid config");
    state.config = raw.config === null ? null : normalizeGitSyncConfig(raw.config);
  } catch (cause) {
    if (!(plain(cause) && cause.code === "ENOENT")) state.error = "Git 同步配置暂不可读，请重新保存仓库设置。";
  }
  publish();
  return {
    getState,
    configure: (value: unknown) => operation(async () => {
      let config: GitSyncConfig | null;
      try { config = value === null ? null : normalizeGitSyncConfig(value); }
      catch (cause) { throw new SyncError(cause instanceof Error ? cause.message : "Git 仓库设置无效。" ); }
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = join(directory, "git-sync.tmp.json");
        await writeFile(temporary, JSON.stringify({ version: 1, config }), { encoding: "utf8", mode: 0o600, flush: true });
        await rename(temporary, configPath);
      } catch { throw new SyncError("Git 仓库设置未能保存，原设置保持不变。" ); }
      observed = false;
      state = { ...state, config, remote: null, lastCheckedAt: null, lastSyncedAt: null };
      return getState();
    }).then(() => getState()),
    check: () => operation(async () => {
      observed = false; state = { ...state, remote: null, lastCheckedAt: null };
      const config = configured(); await requireGit(config);
      const found = await readRemote(config);
      observed = true; state = { ...state, remote: found.remote, lastCheckedAt: Date.now() };
      return getState();
    }).then(() => getState()),
    upload: (text: string) => operation(async () => {
      if (typeof text !== "string") throw new SyncError("本地备份格式不正确。" );
      validate(text);
      const config = configured(); await requireGit(config);
      const found = await checkedRemote(config);
      if (found.text === text) { state = { ...state, lastSyncedAt: Date.now() }; return getState(); }
      const blobResult = await git(config, ["hash-object", "-w", "--stdin", "--no-filters"], { input: text });
      const blob = blobResult.stdout.toString("utf8").trim();
      if (blobResult.code !== 0 || !oid(blob)) throw new SyncError("Git 备份对象无法创建。" );
      const treeBase = await git(config, found.remote.commit ? ["read-tree", `${found.remote.commit}^{tree}`] : ["read-tree", "--empty"]);
      const update = treeBase.code === 0 ? await git(config, ["update-index", "--add", "--cacheinfo", `100644,${blob},${GIT_BACKUP_PATH}`]) : null;
      if (!update || update.code !== 0) throw new SyncError("Git 备份索引无法创建。" );
      const treeResult = await git(config, ["write-tree"]);
      const tree = treeResult.stdout.toString("utf8").trim();
      if (treeResult.code !== 0 || !oid(tree)) throw new SyncError("Git 备份目录无法创建。" );
      const commitResult = await git(config, ["commit-tree", tree, ...(found.remote.commit ? ["-p", found.remote.commit] : []), "-m", "Update TouchFish backup"]);
      const commit = commitResult.stdout.toString("utf8").trim();
      if (commitResult.code !== 0 || !oid(commit)) throw new SyncError("Git 备份提交无法创建。" );
      const ref = `refs/heads/${config.branch}`;
      // Explicit lease is compare-and-swap, not history rewriting: the commit
      // above has exactly the observed head as its sole parent (or no parent
      // for an empty branch). A concurrent advance, reset, or delete rejects.
      const pushed = await git(config, ["push", "--porcelain", "--no-verify", `--force-with-lease=${ref}:${found.remote.commit ?? ""}`, "--", remote(config), `${commit}:${ref}`]);
      if (pushed.code !== 0) {
        observed = false; state = { ...state, remote: null, lastCheckedAt: null };
        if (/stale info|rejected|fetch first|non-fast-forward/i.test(pushed.stderr + pushed.stdout.toString("utf8"))) throw new SyncError(ERROR_CONFLICT);
        throw new SyncError("备份上传未完成，请检查仓库写入权限和网络后重新检查云端。" );
      }
      state = { ...state, remote: { commit, fileExists: true, bytes: Buffer.byteLength(text) }, lastSyncedAt: Date.now() };
      return getState();
    }).then(() => getState()),
    download: () => operation(async () => {
      const config = configured(); await requireGit(config);
      const found = await checkedRemote(config);
      if (!found.remote.commit || found.text === null) throw new SyncError("该分支尚未保存摸鱼时钟备份，请先上传。" );
      return { text: found.text, commit: found.remote.commit };
    }),
    async flush() { await active; },
    dispose() { if (disposed) return; disposed = true; currentAbort?.abort(); observed = false; },
  };
}

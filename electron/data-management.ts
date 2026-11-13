import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createGitDataSync } from "./git-data-sync";
import { MAX_BACKUP_BYTES, parseDataBackup, prepareBackupForImport, summarizeBackup, type DataBackup } from "./data-backup-policy";
import type { BackupPreview, DataManagementState, GitSyncConfig, GitSyncState } from "../src/data-management-types";

interface Options {
  directory: string;
  capture: () => Promise<DataBackup>;
  apply: (backup: DataBackup) => Promise<void>;
  chooseImport: () => Promise<string | null>;
  chooseExport: (suggestedName: string) => Promise<string | null>;
  onState: (state: DataManagementState) => void;
  now?: () => number;
  /** Main-process-only seam for real isolated Git integration tests. */
  gitOptions?: { testRemote?: (config: GitSyncConfig) => string };
}
const safeError = (cause: unknown, fallback: string) => {
  const text = cause instanceof Error ? cause.message : "";
  return text && text.length < 240 && /[\u4e00-\u9fff]/.test(text) && !/https?:|ssh:|[A-Z]:\\|password|authorization|cookie|token\s*[:=]/i.test(text) ? text : fallback;
};

/** Files and remote snapshots are staged in native memory; the UI receives summaries only. */
export async function createDataManagement(options: Options) {
  const now = options.now ?? Date.now;
  const recoveryPath = join(options.directory, "data-recovery.json");
  const emptyGit: GitSyncState = { config: null, gitAvailable: null, busy: false, remote: null, lastCheckedAt: null, lastSyncedAt: null, error: null };
  let state: DataManagementState = { busy: false, message: null, error: null, lastExportAt: null, lastRestoreAt: null, recoveryAvailable: false, git: emptyGit };
  let disposed = false;
  let pending: { preview: BackupPreview; backup: DataBackup; expiresAt: number } | null = null;
  let active: Promise<unknown> | null = null;
  const getState = (): DataManagementState => structuredClone(state);
  const publish = () => { if (!disposed) { try { options.onState(getState()); } catch { /* A reloaded panel reads the current snapshot. */ } } };
  async function readBackup(path: string): Promise<DataBackup> {
    let text: string;
    try {
      if ((await stat(path)).size > MAX_BACKUP_BYTES) throw new Error("备份文件过大，未修改本地数据。");
      text = await readFile(path, "utf8");
    } catch (error) { throw new Error(safeError(error, "无法读取备份文件，请检查文件权限后重试。")); }
    return parseDataBackup(text);
  }
  async function writeBackup(path: string, backup: DataBackup, managed = false) {
    const key = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
    const protectedNames = ["state.json", "state.backup.json", "state.tmp.json", "floating.json", "boss-key.json", "bilibili-history.json", "data-recovery.json", "git-sync.json"];
    if (!managed && protectedNames.some(name => key(path) === key(join(options.directory, name))))
      throw new Error("请将导出备份另存为新文件，不要覆盖应用正在使用的数据文件。");
    const text = `${JSON.stringify(backup, null, 2)}\n`;
    if (Buffer.byteLength(text) > MAX_BACKUP_BYTES) throw new Error("备份数据过大，未写入文件。");
    const temporary = `${path}.touchfish-${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flush: true });
      await rename(temporary, path);
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
      throw new Error("备份文件保存失败，请检查目标目录权限和磁盘空间。");
    }
  }
  function run<T>(message: string, operation: () => Promise<T>): Promise<T> {
    if (disposed) return Promise.reject(new Error("数据管理服务已关闭。"));
    if (active || state.git.busy) return Promise.reject(new Error("已有数据操作正在进行，请稍后重试。"));
    state = { ...state, busy: true, message, error: null }; publish();
    const task = Promise.resolve().then(operation).catch(error => {
      state = { ...state, message: null, error: safeError(error, "数据操作失败，现有本地数据已保留，请重试。") };
      throw new Error(state.error!);
    }).finally(() => { if (active === task) active = null; state = { ...state, busy: false }; publish(); });
    active = task;
    return task;
  }
  function stage(backup: DataBackup, source: BackupPreview["source"], name: string): BackupPreview {
    const summary = summarizeBackup(backup);
    const preview: BackupPreview = {
      id: randomBytes(24).toString("hex"), source, name: name.replace(/[\u0000-\u001f]/g, " ").slice(0, 180),
      exportedAt: summary.exportedAt, appVersion: summary.appVersion,
      recordCount: summary.workdayCount, historyCount: summary.hasHistory ? summary.historyCount : null,
      includesPreferences: summary.hasPreferences,
    };
    pending = { preview, backup: structuredClone(backup), expiresAt: now() + 10 * 60_000 };
    state = { ...state, message: "备份已读取，请核对预览后确认恢复。" };
    return { ...preview };
  }
  try { await readBackup(recoveryPath); state.recoveryAvailable = true; } catch { /* Keep an unreadable recovery file untouched. */ }
  const git = await createGitDataSync({
    directory: options.directory, maxBytes: MAX_BACKUP_BYTES, ...options.gitOptions,
    validateBackup: text => { parseDataBackup(text); },
    onState: next => { state = { ...state, git: next }; publish(); },
  });
  state.git = git.getState(); publish();
  return {
    getState,
    exportBackup: () => run("正在导出本机数据…", async () => {
      const path = await options.chooseExport(`TouchFish-backup-${new Date(now()).toISOString().slice(0, 10)}.json`);
      if (!path) { state.message = "已取消导出。"; return { canceled: true }; }
      const backup = await options.capture();
      await writeBackup(path, backup);
      state = { ...state, lastExportAt: now(), message: "备份已导出，当前工资计时继续。" };
      return { canceled: false, fileName: basename(path) };
    }),
    previewImport: () => run("正在读取备份…", async () => {
      pending = null;
      const path = await options.chooseImport();
      if (!path) { state.message = "已取消选择文件。"; return null; }
      return stage(await readBackup(path), "file", basename(path));
    }),
    previewRecovery: () => run("正在读取恢复副本…", async () => { pending = null; return stage(await readBackup(recoveryPath), "recovery", "上次导入前的本机数据"); }),
    previewRemote: () => run("正在下载云端备份…", async () => {
      pending = null;
      const remote = await git.download();
      return stage(parseDataBackup(remote.text), "git", `云端备份 · ${remote.commit.slice(0, 8)}`);
    }),
    restorePreview: (id: unknown, includePreferences: unknown = true) => run("正在恢复备份…", async () => {
      if (typeof id !== "string" || !pending || id !== pending.preview.id || pending.expiresAt <= now())
        throw new Error("备份预览已过期，请重新选择文件或下载云端备份。");
      if (typeof includePreferences !== "boolean") throw new Error("恢复偏好选项无效。");
      const selected = pending;
      const backup = prepareBackupForImport(selected.backup, now());
      if (!includePreferences) delete backup.preferences;
      const before = await options.capture();
      await mkdir(options.directory, { recursive: true });
      await writeBackup(recoveryPath, before, true);
      state.recoveryAvailable = true;
      await options.apply(backup);
      if (pending === selected) pending = null;
      state = { ...state, lastRestoreAt: now(), message: "数据已恢复，面板正在重新加载；导入的计时保持暂停。" };
    }),
    async cancelPreview(id: unknown) { if (pending && typeof id === "string" && pending.preview.id === id) pending = null; },
    configureGit: (config: GitSyncConfig | null) => run("正在保存 Git 配置…", async () => {
      pending = null;
      await git.configure(config);
      state.message = config ? "Git 仓库已配置，请先检查连接再上传或下载。" : "已断开 Git 云端备份。";
      return getState();
    }).then(() => getState()),
    checkGit: () => run("正在检查 Git 仓库…", async () => {
      await git.check();
      state.message = git.getState().remote?.fileExists ? "已找到云端备份，可下载预览或上传本机数据。" : "连接成功，尚无云端备份，可上传本机数据。";
      return getState();
    }).then(() => getState()),
    uploadGit: () => run("正在上传本机备份…", async () => {
      await git.upload(JSON.stringify(await options.capture()));
      state.message = "本机数据已上传，旧版本保留在 Git 提交历史中。";
      return getState();
    }).then(() => getState()),
    async flush() { await active?.catch(() => {}); await git.flush(); },
    dispose() { disposed = true; pending = null; git.dispose(); },
  };
}

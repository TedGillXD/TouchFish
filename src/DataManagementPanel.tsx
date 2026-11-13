import { useEffect, useRef, useState } from "react";
import { Check, CloudDownload, CloudUpload, Database, Download, FileCheck2, GitBranch, LoaderCircle, RefreshCw, RotateCcw, Save, Upload, X } from "lucide-react";
import type { BackupPreview, DataManagementApi, DataManagementState, GitSyncConfig } from "./data-management-types";
import "./data-management.css";

const dateLabel = (value: string | number | null | undefined) => {
  if (value === null || value === undefined) return "未记录";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    : "时间未知";
};
const safeMessage = (message: unknown, fallback: string) => typeof message === "string" && message.length < 240 &&
  !/https?:\/\/|ssh:\/\/|SESSDATA|cookie\s*[:=]|authorization|password|token\s*[:=]|[A-Z]:\\/i.test(message)
  ? message : fallback;
const errorText = (cause: unknown) => safeMessage(cause instanceof Error
  ? cause.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "") : null,
"操作未完成，请检查备份文件或 Git 连接后重试。");

/** Backups and repository preferences apply separately from the wage draft. */
export default function DataManagementPanel({ hasUnsavedSettings }: { hasUnsavedSettings: boolean }) {
  const api = (window.touchFish as typeof window.touchFish & { dataManagement?: DataManagementApi })?.dataManagement;
  const [state, setState] = useState<DataManagementState | null>(null);
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("main");
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [restorePreferences, setRestorePreferences] = useState(true);
  const [uploadConfirm, setUploadConfirm] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  const revision = useRef(0);
  const savedConfig = useRef<string | undefined>(undefined);
  const previewRef = useRef<BackupPreview | null>(null);
  const previewElement = useRef<HTMLDivElement | null>(null);
  const uploadElement = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = preview ? previewElement.current : uploadConfirm ? uploadElement.current : null;
    if (element) { element.scrollIntoView({ block: "start", behavior: "auto" }); element.focus({ preventScroll: true }); }
  }, [preview?.id, uploadConfirm]);

  const accept = (next: DataManagementState) => {
    if (!mounted.current) return;
    setState(next);
    const config = JSON.stringify(next.git.config);
    if (savedConfig.current !== config) {
      savedConfig.current = config;
      setRepository(next.git.config?.repository ?? "");
      setBranch(next.git.config?.branch ?? "main");
    }
  };
  useEffect(() => {
    mounted.current = true;
    if (!api) return () => { mounted.current = false; };
    let active = true;
    const off = api.onState(next => { if (active) { revision.current++; accept(next); } });
    const requestedAt = revision.current;
    void api.getState().then(next => {
      if (active && requestedAt === revision.current) accept(next);
    }).catch(cause => { if (active && mounted.current) setError(errorText(cause)); });
    return () => {
      mounted.current = false;
      active = false;
      off();
      const staged = previewRef.current;
      if (staged) void api.cancelPreview(staged.id).catch(() => {});
    };
  }, [api]);

  async function perform<T>(label: string, operation: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    if (!api || pending.current || state?.busy || state?.git.busy) return { ok: false };
    pending.current = true;
    setAction(label); setError(""); setNotice("");
    try {
      const value = await operation();
      return { ok: true, value };
    } catch (cause) {
      if (mounted.current) setError(errorText(cause));
      return { ok: false };
    } finally {
      pending.current = false;
      if (mounted.current) setAction(null);
    }
  }
  const stagePreview = (next: BackupPreview | null) => {
    if (!mounted.current) return;
    previewRef.current = next;
    setPreview(next);
    setUploadConfirm(false);
  };
  const exportBackup = async () => {
    const result = await perform("export", () => api!.exportBackup());
    if (result.ok && mounted.current && !result.value.canceled)
      setNotice(result.value.fileName ? `备份已导出：${result.value.fileName}` : "备份已导出。");
  };
  const choosePreview = async (source: "file" | "git" | "recovery") => {
    const result = await perform(source, () => source === "file" ? api!.previewImport()
      : source === "git" ? api!.previewRemote() : api!.previewRecovery());
    if (result.ok) {
      if (!mounted.current && result.value) void api!.cancelPreview(result.value.id).catch(() => {});
      else stagePreview(result.value);
    }
  };
  const cancelPreview = async () => {
    const staged = previewRef.current;
    if (!staged) return;
    stagePreview(null);
    await perform("cancel", () => api!.cancelPreview(staged.id));
  };
  const restore = async () => {
    const staged = previewRef.current;
    if (!staged || hasUnsavedSettings) return;
    const result = await perform("restore", () => api!.restorePreview(staged.id, restorePreferences));
    if (result.ok) {
      stagePreview(null);
      if (mounted.current) setNotice("数据已恢复，计薪记录保持暂停。");
    }
  };
  const saveGit = async (config: GitSyncConfig | null) => {
    const before = revision.current;
    const result = await perform("configure", () => api!.configureGit(config));
    if (result.ok && mounted.current) {
      if (before === revision.current) accept(result.value);
      if (!result.value.error && !result.value.git.error)
        setNotice(config ? "仓库配置已保存，请检查云端后再上传或恢复。" : "已断开仓库，远端备份仍保留。");
    }
  };
  const checkGit = async () => {
    const before = revision.current;
    const result = await perform("check", () => api!.checkGit());
    if (result.ok && before === revision.current) accept(result.value);
  };
  const upload = async () => {
    setUploadConfirm(false);
    const before = revision.current;
    const result = await perform("upload", () => api!.uploadGit());
    if (result.ok && mounted.current) {
      if (before === revision.current) accept(result.value);
      if (!result.value.error && !result.value.git.error)
        setNotice("本机备份已上传，远端旧版本保留在 Git 历史中。");
    }
  };
  const retryRead = async () => {
    const before = revision.current;
    const result = await perform("read", () => api!.getState());
    if (result.ok && before === revision.current) accept(result.value);
  };

  if (!api) return null;
  const busy = !!action || state?.busy === true || state?.git.busy === true;
  const locked = busy || !!preview || uploadConfirm;
  const configured = !!state?.git.config;
  const configDirty = repository.trim() !== (state?.git.config?.repository ?? "") || branch.trim() !== (state?.git.config?.branch ?? "main");
  const ready = !!state && !locked;
  const canBackup = ready && !hasUnsavedSettings;
  const canCheck = ready && configured && !configDirty;
  const canSync = canCheck && state.git.gitAvailable === true && !!state.git.remote && !state.git.error;
  const displayedError = error || state?.error || state?.git.error;
  const message = notice || state?.message;
  const checkingGitLabel = state?.git.gitAvailable === true ? "Git 可用" : state?.git.gitAvailable === false ? "未检测到 Git" : "待检查 Git";

  return <section className="settings-group data-management" aria-label="数据管理" aria-busy={busy}>
    <h2><Database size={15} />数据管理</h2>
    <p className="data-description">备份工资与排班设置、工作记录、视频历史和偏好设置，方便换机或恢复。</p>
    <div className="data-local-actions">
      <button disabled={!canBackup} onClick={() => void exportBackup()}>{action === "export" ? <LoaderCircle size={13} className="data-loader" /> : <Download size={13} />}导出备份</button>
      <button disabled={!canBackup} onClick={() => void choosePreview("file")}>{action === "file" ? <LoaderCircle size={13} className="data-loader" /> : <Upload size={13} />}导入备份</button>
      {state?.recoveryAvailable && <button disabled={!canBackup} onClick={() => void choosePreview("recovery")}><RotateCcw size={13} />恢复导入前数据</button>}
    </div>
    <p className="data-hint">备份不包含登录 Cookie、密码或 Git 凭据。导入前会显示摘要，并自动保留当前数据的恢复副本。</p>
    {state?.lastExportAt && <p className="data-hint">上次导出 · {dateLabel(state.lastExportAt)}</p>}
    {state?.lastRestoreAt && <p className="data-hint">上次恢复 · {dateLabel(state.lastRestoreAt)}</p>}

    <div className="data-cloud" aria-label="Git云端备份">
      <div className="data-cloud-heading"><h3><GitBranch size={14} />个人 Git 仓库</h3><span className={`data-git-status ${state?.git.gitAvailable ? "available" : ""}`} role="status">{checkingGitLabel}</span></div>
      <p className="data-hint">支持私有仓库，沿用电脑上已配置的 Git／SSH 登录。备份包含工资等个人数据，请选择自己的私有仓库。</p>
      <label className="data-git-field"><span>仓库链接</span><input aria-label="备份Git仓库链接" value={repository} disabled={!state || locked} placeholder="https://github.com/你的账号/备份仓库.git" spellCheck={false} autoComplete="off" maxLength={2048} onChange={event => setRepository(event.target.value)} /></label>
      <label className="data-git-field"><span>分支</span><input aria-label="备份Git分支" value={branch} disabled={!state || locked} placeholder="main" spellCheck={false} autoComplete="off" maxLength={200} onChange={event => setBranch(event.target.value)} /></label>
      <p className="data-hint">仅读写此分支内的 <code>touchfish-backup.json</code>，其它文件保持原样。首次连接前，请在系统 Git 中完成登录或 SSH 认证。</p>
      <div className="data-config-actions"><button disabled={!state || locked || !repository.trim() || !branch.trim() || !configDirty} onClick={() => void saveGit({ repository: repository.trim(), branch: branch.trim() })}><Save size={12} />保存仓库</button>{configured && <button disabled={locked} onClick={() => void saveGit(null)}><X size={12} />断开仓库</button>}{configDirty && <span className="data-config-note">仓库配置尚未保存</span>}</div>
      <div className="data-cloud-actions">
        <button disabled={!canCheck} onClick={() => void checkGit()}>{action === "check" ? <LoaderCircle size={12} className="data-loader" /> : <RefreshCw size={12} />}检查云端</button>
        <button disabled={!canSync || hasUnsavedSettings} onClick={() => { setError(""); setNotice(""); setUploadConfirm(true); }}><CloudUpload size={13} />上传本机</button>
        <button disabled={!canSync || !state.git.remote?.fileExists || hasUnsavedSettings} onClick={() => void choosePreview("git")}><CloudDownload size={13} />下载恢复</button>
      </div>
      {configured && !configDirty && state?.git.remote && <p className="data-hint">{state.git.remote.fileExists ? `云端已有备份 · ${(state.git.remote.bytes / 1024).toFixed(1)} KB` : "云端尚无备份，可上传本机数据。"}{state.git.lastCheckedAt ? ` · 检查于 ${dateLabel(state.git.lastCheckedAt)}` : ""}</p>}
      {state?.git.lastSyncedAt && <p className="data-hint">上次云端同步 · {dateLabel(state.git.lastSyncedAt)}</p>}
      {configured && !configDirty && !state?.git.remote && <p className="data-hint">先检查云端，再上传本机数据或下载备份。远端发生变化时会提示重新检查。</p>}
    </div>

    {uploadConfirm && <div className="data-preview" ref={uploadElement} tabIndex={-1} role="group" aria-label="上传备份确认">
      <h3><CloudUpload size={14} />上传本机备份</h3>
      <dl><dt>仓库</dt><dd>{state?.git.config?.repository}</dd><dt>分支</dt><dd>{state?.git.config?.branch}</dd><dt>文件</dt><dd>touchfish-backup.json</dd></dl>
      <p className="data-preview-note">将本机当前数据提交到云端，旧备份保留在 Git 提交历史中。此操作不会修改本机记录。</p>
      <div className="data-preview-actions"><button className="text-button" disabled={busy} onClick={() => setUploadConfirm(false)}>取消上传</button><button className="primary" disabled={busy || hasUnsavedSettings} onClick={() => void upload()}><CloudUpload size={13} />确认上传</button></div>
    </div>}

    {preview && <div className="data-preview" ref={previewElement} tabIndex={-1} role="group" aria-label="导入备份预览">
      <h3><FileCheck2 size={14} />{preview.source === "git" ? "云端备份预览" : preview.source === "recovery" ? "恢复副本预览" : "备份文件预览"}</h3>
      <dl><dt>来源</dt><dd>{preview.name}</dd><dt>备份时间</dt><dd>{dateLabel(preview.exportedAt)}</dd><dt>应用版本</dt><dd>{preview.appVersion ? `v${preview.appVersion}` : "旧版数据文件"}</dd><dt>工作记录</dt><dd>{preview.recordCount} 天</dd><dt>视频历史</dt><dd>{preview.historyCount === null ? "不包含，保留本机历史" : `${preview.historyCount} 条`}</dd><dt>偏好设置</dt><dd>{preview.includesPreferences ? "可选择一并恢复" : "不包含，保留本机偏好"}</dd></dl>
      {preview.includesPreferences && <label className="data-preferences-choice"><input type="checkbox" checked={restorePreferences} disabled={busy} onChange={event => setRestorePreferences(event.target.checked)} />同时恢复悬浮窗和老板键偏好</label>}
      <p className="data-preview-note">确认后将覆盖备份中包含的本机数据，并保留当前数据的恢复副本。恢复后的计薪记录保持暂停，需要你手动继续工作。</p>
      <div className="data-preview-actions"><button className="text-button" disabled={busy} onClick={() => void cancelPreview()}>取消导入</button><button className="primary" disabled={busy || hasUnsavedSettings} onClick={() => void restore()}>{action === "restore" ? <LoaderCircle size={13} className="data-loader" /> : <Check size={13} />}确认覆盖并恢复</button></div>
    </div>}

    {hasUnsavedSettings && <p className="data-unsaved">工资设置尚未保存，请先保存，再导出、上传或恢复备份。</p>}
    {displayedError ? <div className="data-status data-error" role="alert"><span>{safeMessage(displayedError, "数据操作未完成，请重新检查备份或仓库配置。")}</span>{!state && <button className="text-button" disabled={busy} onClick={() => void retryRead()}>重新读取</button>}</div>
      : message && <p className="data-status" role="status">{safeMessage(message, "数据状态已更新。")}</p>}
    {!state && !error && <p className="data-hint" role="status">正在读取备份配置…</p>}
  </section>;
}

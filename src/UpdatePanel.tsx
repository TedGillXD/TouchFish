import { useEffect, useState } from "react";
import { Download, ExternalLink, RefreshCw, ShieldCheck } from "lucide-react";
import packageInfo from "../package.json";
import type { UpdateState } from "./update-types";

const bytes = (value: number = 0) => `${(value / 1024 / 1024).toFixed(1)} MB`;

export default function UpdatePanel({
  hasUnsavedSettings,
}: {
  hasUnsavedSettings: boolean;
}) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [actionError, setActionError] = useState("");
  useEffect(() => {
    const api = window.touchFish?.updater;
    if (!api) return;
    let mounted = true;
    const off = api.onState((next) => {
      if (mounted) setState(next);
    });
    void api
      .getState()
      .then((next) => {
        if (mounted) setState(next);
      })
      .catch(() => {
        if (mounted) setActionError("无法读取更新状态，请重试。");
      });
    return () => {
      mounted = false;
      off();
    };
  }, []);
  const api = window.touchFish?.updater;
  const status = state?.status || "idle";
  const busy = ["checking", "downloading", "installing"].includes(status);
  const perform = async (
    action: "check" | "download" | "install" | "openReleasePage",
  ) => {
    setActionError("");
    if (!api) return;
    try {
      const result = await api[action]();
      if (result && typeof result === "object") setState(result);
    } catch {
      try {
        const latest = await api.getState();
        setState(latest);
        if (latest.status === "error") return;
      } catch {}
      setActionError("更新操作未完成，请重试；安装前请确认工作记录已保存。");
    }
  };
  return (
    <section className="settings-group app-update" aria-label="应用更新">
      <div className="update-heading">
        <h2>
          <RefreshCw size={15} />
          应用更新
        </h2>
        <span>v{state?.currentVersion || packageInfo.version}</span>
      </div>
      <p className="update-proxy">
        <ShieldCheck size={12} />
        检查与下载均跟随系统代理设置（含 PAC）
      </p>
      <p
        className={`update-message ${status === "error" ? "failed" : ""}`}
        role="status"
      >
        {actionError ||
          state?.message ||
          (api
            ? "检查 GitHub 上发布的稳定版本。"
            : "浏览器预览中无法更新，请使用桌面应用。")}
      </p>
      {status === "downloading" && (
        <div className="update-download">
          <div
            className="progress-track"
            role="progressbar"
            aria-label="更新下载进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(state?.progress || 0)}
          >
            <div
              style={{
                width: `${Math.min(100, Math.max(0, state?.progress || 0))}%`,
              }}
            />
          </div>
          <span>
            {Math.round(state?.progress || 0)}% · {bytes(state?.transferred)} /{" "}
            {bytes(state?.total)}
          </span>
        </div>
      )}
      <div className="update-actions">
        {status === "available" ? (
          <button className="primary" onClick={() => void perform("download")}>
            <Download size={14} />
            下载 {state?.latestVersion ? `v${state.latestVersion}` : "更新"}
          </button>
        ) : status === "downloaded" ? (
          <button
            className="primary"
            disabled={hasUnsavedSettings}
            onClick={() => void perform("install")}
          >
            <Download size={14} />
            {state?.installLabel ||
              (state?.mode === "automatic"
                ? "重启并安装更新"
                : "打开更新安装包")}
          </button>
        ) : (
          <button
            className="secondary"
            disabled={!api || busy || status === "unsupported"}
            onClick={() => void perform("check")}
          >
            <RefreshCw size={14} className={busy ? "spinning" : ""} />
            {status === "checking"
              ? "正在检查…"
              : status === "downloading"
                ? "正在下载…"
                : status === "installing"
                  ? "正在启动安装…"
                  : "检查更新"}
          </button>
        )}
        <button
          className="text-button"
          disabled={!api || status === "installing"}
          onClick={() => void perform("openReleasePage")}
        >
          发行记录 <ExternalLink size={11} />
        </button>
      </div>
      {status === "downloaded" && hasUnsavedSettings && (
        <p className="update-save-hint">请先保存设置，再安装更新。</p>
      )}
    </section>
  );
}

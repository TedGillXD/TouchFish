import { useEffect, useState } from "react";
import { PanelsTopLeft } from "lucide-react";
import type { FloatingState } from "./floating-types";
import "./floating.css";

/** Window preferences apply immediately, independently of the payroll draft. */
export default function FloatingSettings() {
  const [state, setState] = useState<FloatingState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const api = window.touchFish?.floating;
  const windows = window.touchFish?.platform === "win32";
  useEffect(() => {
    if (!windows || !api) return;
    let mounted = true;
    let revision = 0;
    const off = api.onState((next) => {
      revision++;
      if (mounted) setState(next);
    });
    void api.getState().then(
      (next) => {
        if (mounted && revision === 0) {
          setState(next);
          setError("");
        }
      },
      () => {
        if (mounted) setError("无法读取悬浮窗设置，请重试。");
      },
    );
    return () => { mounted = false; off(); };
  }, [api, windows, reload]);
  if (!windows || state?.supported === false) return null;
  const toggle = async () => {
    if (!api || !state || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.setEnabled(!state.enabled);
    } catch {
      setError("悬浮窗设置未保存，请重试。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-group floating-settings" aria-label="Windows 悬浮窗">
      <div className="switch-row">
        <div>
          <h2><PanelsTopLeft size={15} />Windows 悬浮窗</h2>
          <p>小小一角，随时看到今日进度</p>
        </div>
        <button
            role="switch"
            aria-label="显示 Windows 悬浮窗"
            aria-checked={state?.enabled === true}
            className={`switch ${state?.enabled ? "on" : ""}`}
            disabled={!state || busy}
            onClick={() => void toggle()}
        ><span /></button>
      </div>
      <p className="floating-settings-hint">
        拖动百分比移动，点击箭头查看收入；右键图标可隐藏或重置位置。
        金额显示与主面板同步，此开关立即生效。
      </p>
      {error && (
        <div className="floating-settings-error" role="alert">
          <span>{error}</span>
          <button className="text-button" onClick={() => state ? void toggle() : setReload((v) => v + 1)}>重试</button>
        </div>
      )}
    </section>
  );
}

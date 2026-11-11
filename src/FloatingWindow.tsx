import { useCallback, useEffect, useState } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  CircleDollarSign,
  RotateCcw,
} from "lucide-react";
import { emptyData, getDaySummary, normalizeData, type AppData } from "./core";
import type { FloatingState } from "./floating-types";

const duration = (seconds: number) => {
  const value = Math.floor(Math.max(0, seconds));
  return [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
};
const money = (value: number) =>
  value.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** A read-only companion. Work records are changed only in the full panel. */
export default function FloatingWindow() {
  const [data, setData] = useState<AppData | null>(null);
  const [state, setState] = useState<FloatingState | null>(null);
  const [now, setNow] = useState(Date.now());
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState("");
  const [reload, setReload] = useState(0);
  const api = window.touchFish?.floating;

  useEffect(() => {
    const desktop = window.touchFish;
    if (!desktop) {
      setLoadError(true);
      return;
    }
    let mounted = true;
    let dataRevision = 0;
    let stateRevision = 0;
    // Subscribe before requesting the snapshot, so a save during load cannot
    // replace a newer broadcast with the older disk snapshot.
    const offData = desktop.onData((next) => {
      dataRevision++;
      if (mounted) {
        setData(normalizeData(next));
        setLoadError(false);
      }
    });
    const offState = desktop.floating.onState((next) => {
      stateRevision++;
      if (mounted) setState(next);
    });
    void desktop.loadData().then(
      (raw) => {
        if (mounted && dataRevision === 0) {
          setData(raw ? normalizeData(raw) : emptyData());
          setLoadError(false);
        }
      },
      () => {
        if (mounted && dataRevision === 0) setLoadError(true);
      },
    );
    void desktop.floating.getState().then(
      (next) => {
        if (mounted && stateRevision === 0) setState(next);
      },
      () => {
        if (mounted) setLoadError(true);
      },
    );
    return () => {
      mounted = false;
      offData();
      offState();
    };
  }, [reload]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const toggle = useCallback(async () => {
    if (!api || !state) return;
    setActionError("");
    try {
      // The ordered broadcast also contains privacy changes from the main
      // panel. An older invoke reply must never reveal a hidden amount.
      await api.setExpanded(!state.expanded);
    } catch {
      setActionError("操作失败，请重试");
    }
  }, [api, state]);

  const summary = data ? getDaySummary(data, now) : null;
  const ready = !!summary && !!state && !loadError;
  const expanded = state?.expanded === true;
  const active = ready && summary.status === "working";
  const beforeStart = active && now < summary.plan.start;
  const inLunch = active && summary.plan.breakStart !== null &&
    summary.plan.breakEnd !== null && now >= summary.plan.breakStart &&
    now < summary.plan.breakEnd;
  const inDinner = active && summary.plan.dinnerStart !== null &&
    summary.plan.dinnerEnd !== null && now >= summary.plan.dinnerStart &&
    now < summary.plan.dinnerEnd;
  const resting = beforeStart || inLunch || inDinner;
  const status = !ready ? (loadError ? "读取失败" : "正在同步")
    : beforeStart ? "等待上班"
    : inDinner ? "晚饭中"
    : inLunch ? "午休中"
    : summary.status === "working" ? "计时中"
    : summary.status === "paused" ? "已暂停"
    : summary.status === "completed" ? "已下班"
    : summary.status === "rest" ? "休息日" : "未开始";
  const percent = ready ? summary.progress * 100 : 0;
  const compactLabel = !ready ? "—" : summary.status === "rest"
    ? "休息日" : `${percent.toFixed(1)}%`;

  return (
    <main
      className={`floating-card ${expanded ? "expanded" : "compact"} ${active && !resting ? "ticking" : ""}`}
      aria-label="摸鱼时钟悬浮窗"
      onContextMenu={(event) => {
        event.preventDefault();
        api?.menu();
      }}
    >
      <div className="floating-topline">
        <button
          className="floating-coin"
          aria-label="打开完整面板"
          title="打开完整面板"
          onClick={() => api?.openPanel()}
        >
          <CircleDollarSign size={21} aria-hidden="true" />
        </button>
        <div className="floating-drag" title="拖动移动 · 右键图标打开菜单">
          {expanded && <span className="floating-caption">今日工作进度</span>}
          <strong className="floating-percent">{compactLabel}</strong>
        </div>
        <button
          className="floating-expand"
          aria-label={loadError ? "重试读取" : expanded ? "收起悬浮窗" : "展开悬浮窗"}
          aria-expanded={expanded}
          title={expanded ? "收起悬浮窗" : "展开悬浮窗"}
          onClick={() => loadError ? setReload((v) => v + 1) : void toggle()}
          disabled={!state && !loadError}
        >
          {loadError ? <RotateCcw size={13} /> : expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        </button>
      </div>
      {expanded && (
        <div className="floating-detail">
          <div className="floating-income-row">
            <div className="floating-income">
              <span className="floating-caption">今日已赚</span>
              <strong
                className="floating-earnings"
                style={ready && !state.privacy && money(summary.earnings).length > 10 ? { fontSize: 18 } : undefined}
              >
                {!ready ? "—" : state.privacy ? "••••" : `¥${money(summary.earnings)}`}
              </strong>
            </div>
            <span className={`floating-status ${active && !resting ? "active" : ""}`}>
              <i aria-hidden="true" />{status}
            </span>
          </div>
          <div
            className="floating-progress"
            role="progressbar"
            aria-label="今日工作进度"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={ready ? Math.round(percent * 10) / 10 : undefined}
            aria-valuetext={ready ? `${percent.toFixed(1)}%` : "正在同步"}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
          <div className="floating-footer">
            {loadError ? (
              <button className="floating-retry" onClick={() => setReload((v) => v + 1)}>
                <RotateCcw size={11} />重试读取
              </button>
            ) : (
              <span className="floating-duration">{ready ? duration(summary.seconds) : "—"}</span>
            )}
            <button className="floating-open" onClick={() => api?.openPanel()}>
              完整面板 <ArrowUpRight size={12} />
            </button>
          </div>
          {actionError && <span className="floating-action-error" role="alert">{actionError}</span>}
        </div>
      )}
    </main>
  );
}

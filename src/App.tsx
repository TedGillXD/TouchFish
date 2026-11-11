import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Coffee,
  Eye,
  EyeOff,
  Fish,
  Flag,
  Minus,
  Pause,
  Play,
  Power,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  Utensils,
  Wallet,
} from "lucide-react";
import {
  dateKey,
  emptyData,
  finishWork,
  getDaySummary,
  getNextPayday,
  getPayrollPeriod,
  isWorkday,
  monthDays,
  periodEarnings,
  normalizeData,
  normalizeSettings,
  pauseWork,
  reconcileData,
  startWork,
  validateSettings,
  type AppData,
  type Settings,
} from "./core";
import { getPublicHoliday, getHolidayYears } from "./holidays";
import HolidaySettings from "./HolidaySettings";
import { useHolidayState, useHolidayYears, yearsForDates } from "./holiday-client";
import UpdatePanel from "./UpdatePanel";
import FloatingSettings from "./FloatingSettings";
import {
  PayrollPanel,
  PayrollSettings,
  periodRange,
  shortDate,
} from "./Payroll";

type View = "home" | "settings" | "calendar" | "history" | "payroll";
const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
const money = (n: number) =>
  n.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const duration = (n: number) => {
  const s = Math.floor(Math.max(0, n));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60]
    .map((x) => String(x).padStart(2, "0"))
    .join(":");
};
const modeNames = { double: "双休", single: "单休", alternate: "大小周" };
const clockTime = (timestamp: number) =>
  new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

function App() {
  const holidayState = useHolidayState();
  const [data, setData] = useState<AppData | null>(null);
  const [now, setNow] = useState(Date.now());
  const [view, setView] = useState<View>("home");
  const [payrollFocus, setPayrollFocus] = useState<string | undefined>();
  const [hidden, setHidden] = useState(!!window.touchFish);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [confirmFinish, setConfirmFinish] = useState(false);
  const saved = useRef<AppData | null>(null);
  const loaded = useRef(false);

  const load = useCallback(async () => {
    try {
      const raw = window.touchFish
        ? await window.touchFish.loadData()
        : JSON.parse(localStorage.getItem("touchfish-preview") || "null");
      const next = reconcileData(
        raw ? normalizeData(raw) : emptyData(),
        Date.now(),
      );
      saved.current =
        raw && JSON.stringify(raw) === JSON.stringify(next) ? next : null;
      loaded.current = true;
      setData(next);
      setError("");
    } catch {
      setError("读取本地数据失败，请重试。原有数据不会被覆盖。");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => window.touchFish?.onSettings(() => setView("settings")), []);
  useEffect(() => {
    const api = window.touchFish?.floating;
    if (!api) return;
    let active = true;
    let revision = 0;
    const unsubscribe = api.onState((state) => {
      revision++;
      if (active) setHidden(state.privacy);
    });
    void api.getState().then((state) => {
      if (active && revision === 0) setHidden(state.privacy);
    }).catch(() => {
      if (active) setError("无法读取金额隐藏设置，已暂时隐藏金额。");
    });
    return () => { active = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!data) return;
    const stale = Object.values(data.records).some(
      (r) => !r.completed && now >= r.plan.end,
    );
    if (stale)
      setData((current) => (current ? reconcileData(current, now) : current));
  }, [now, data]);
  useEffect(() => {
    if (!data || !loaded.current || data === saved.current) return;
    const write = async () => {
      try {
        if (window.touchFish) await window.touchFish.saveData(data);
        else localStorage.setItem("touchfish-preview", JSON.stringify(data));
        saved.current = data;
        setError("");
      } catch {
        setError("保存失败，记录暂存在内存中。请检查磁盘空间后重试。");
      }
    };
    void write();
  }, [data]);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 2600);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const summary = data ? getDaySummary(data, now) : null;
  const todayKey = dateKey(now);
  const currentPeriod = useMemo(
    () => (data ? getPayrollPeriod(todayKey, data.settings) : null),
    [data?.settings, todayKey, holidayState.years],
  );
  const nextPayday = useMemo(
    () => (data ? getNextPayday(todayKey, data.settings) : null),
    [data?.settings, todayKey, holidayState.years],
  );
  useHolidayYears(
    yearsForDates(todayKey, currentPeriod?.start, currentPeriod?.end,
      currentPeriod?.nominalPayday, nextPayday?.nominalPayday, nextPayday?.actualPayday),
    data?.settings.publicHolidays !== false,
  );
  useEffect(() => {
    if (summary)
      window.touchFish?.updateStatus?.(
        `摸鱼时钟 · 今日 ${hidden ? "金额已隐藏" : `¥${money(summary.earnings)}`} · ${summary.status === "working" ? "计时中" : summary.status === "completed" ? "已下班" : "点击打开"}`,
      );
  }, [summary?.earnings, summary?.status, hidden]);

  if (!data || !summary || !currentPeriod)
    return (
      <div className="app-shell">
        <div className="loading">
          <span className="brand-icon">
            <Fish size={25} />
          </span>
          <strong>摸鱼时钟</strong>
          <p>{error || "正在整理今天的好心情…"}</p>
          {error && (
            <button className="primary" onClick={() => void load()}>
              重新读取
            </button>
          )}
        </div>
      </div>
    );
  const date = new Date(now);
  const year = date.getFullYear(),
    month = date.getMonth() + 1;
  const days = currentPeriod.workdays;
  const today = todayKey;
  const working = summary.status === "working";
  const lunch =
    working &&
    summary.plan.breakStart !== null &&
    summary.plan.breakEnd !== null &&
    now >= summary.plan.breakStart &&
    now < summary.plan.breakEnd;
  const dinner =
    working &&
    summary.plan.dinnerStart !== null &&
    summary.plan.dinnerEnd !== null &&
    now >= summary.plan.dinnerStart &&
    now < summary.plan.dinnerEnd;
  const mealBreak = lunch || dinner;
  const beforeStart = working && now < summary.plan.start;
  const status = mealBreak
    ? dinner
      ? "晚饭中"
      : "午休中"
    : beforeStart
      ? "等待上班"
      : {
          idle: "待开工",
          working: "正在工作",
          paused: "已暂停",
          completed: "已下班",
          rest: "休息日",
        }[summary.status];
  let elapsedWorkdays = 0;
  const elapsedDate = new Date(`${currentPeriod.start}T12:00:00`);
  while (
    dateKey(elapsedDate) < today &&
    dateKey(elapsedDate) <= currentPeriod.end
  ) {
    if (isWorkday(dateKey(elapsedDate), data.settings)) elapsedWorkdays++;
    elapsedDate.setDate(elapsedDate.getDate() + 1);
  }
  const startTime = new Date(summary.plan.start).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const mealRanges = [
    {
      label: "午休",
      start: summary.plan.breakStart,
      end: summary.plan.breakEnd,
    },
    {
      label: "晚饭",
      start: summary.plan.dinnerStart,
      end: summary.plan.dinnerEnd,
    },
  ].filter(
    (meal): meal is { label: string; start: number; end: number } =>
      meal.start !== null && meal.end !== null && meal.end > meal.start,
  );
  const mealSchedule = mealRanges
    .map(
      (meal) => `${meal.label} ${clockTime(meal.start)}–${clockTime(meal.end)}`,
    )
    .join(" · ");
  const activeMealEnd = Math.max(
    lunch ? summary.plan.breakEnd! : 0,
    dinner ? summary.plan.dinnerEnd! : 0,
  );
  const nextEnd = new Date(summary.plan.end).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const cash = (n: number) => (hidden ? "••••" : money(n));
  const mutate = (fn: (d: AppData, time: number) => AppData) => {
    setData((current) => (current ? fn(current, Date.now()) : current));
    setNow(Date.now());
  };
  const openPayroll = (focus?: string) => {
    setPayrollFocus(focus);
    setView("payroll");
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <button
          className="brand"
          title="返回今日概览"
          onClick={() => setView("home")}
        >
          <span className="brand-icon">
            <Fish size={23} strokeWidth={2.2} />
          </span>
          <span>
            摸鱼时钟<small>TOUCHFISH</small>
          </span>
        </button>
        <div className="header-actions">
          <button
            className={`icon-button ${view === "calendar" ? "selected" : ""}`}
            title="工作日历"
            onClick={() => setView(view === "calendar" ? "home" : "calendar")}
          >
            <CalendarDays size={17} />
          </button>
          <button
            className="icon-button"
            title={hidden ? "显示金额" : "隐藏金额"}
            onClick={() => {
              if (!window.touchFish) setHidden(!hidden);
              else void window.touchFish.floating.setPrivacy(!hidden).catch(() =>
                setError("金额隐藏设置保存失败，请重试。"),
              );
            }}
          >
            {hidden ? <EyeOff size={18} /> : <Eye size={18} />}
          </button>
          <button
            className={`icon-button ${view === "settings" ? "selected" : ""}`}
            title="设置"
            onClick={() => setView(view === "settings" ? "home" : "settings")}
          >
            <Settings2 size={18} />
          </button>
          <span className="header-divider" />
          <button
            className="icon-button"
            title="收起到托盘"
            onClick={() => window.touchFish?.hide()}
          >
            <Minus size={18} />
          </button>
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button
            onClick={() => {
              saved.current = null;
              setData({ ...data });
            }}
          >
            重试
          </button>
        </div>
      )}

      <main
        className={`main-content ${view !== "home" ? "secondary-content" : ""}`}
      >
        {view === "home" && (
          <>
            <div className="greeting">
              <span>
                {month}月{date.getDate()}日 <i>·</i> 星期
                {weekdays[date.getDay()]}
              </span>
              <span>
                <span className="tiny-sun">
                  <Sun size={13} />
                </span>{" "}
                每一秒，都算数
              </span>
            </div>
            <section
              className={`earnings-card ${working && !mealBreak && !beforeStart ? "is-working" : ""}`}
            >
              <div className="card-heading">
                <span>
                  <Wallet size={17} /> 今日已赚
                </span>
                <span className={`status ${working ? "live" : ""}`}>
                  <b />
                  {status}
                </span>
              </div>
              <div className="earnings">
                <span className="currency">¥</span>
                <span>{cash(summary.earnings)}</span>
                <span className="amount-unit">税前</span>
              </div>
              <div className="progress-caption">
                <span>
                  今日目标 <strong>¥{cash(summary.dailyWage)}</strong>
                </span>
                <strong>
                  {(summary.progress * 100).toFixed(1)}
                  <span>%</span>
                </strong>
              </div>
              <div
                className="progress-track"
                role="progressbar"
                aria-label="今日上班进度"
                aria-valuenow={Number((summary.progress * 100).toFixed(1))}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  style={{ width: `${Math.min(100, summary.progress * 100)}%` }}
                />
              </div>
              <div className="earnings-details">
                <div>
                  <span>已计薪时长</span>
                  <strong className="mono">{duration(summary.seconds)}</strong>
                </div>
                <span className="detail-divider" />
                <div>
                  <span>每秒收入</span>
                  <strong>
                    ¥{hidden ? "••••" : summary.perSecond.toFixed(4)}
                    <small> / 秒</small>
                  </strong>
                </div>
              </div>
            </section>

            <section className="work-section">
              <div className="section-label">
                <span>
                  <Clock3 size={16} /> 今日工作
                </span>
                <button
                  className="text-button"
                  onClick={() => setView("settings")}
                >
                  调整时间 <ChevronRight size={13} />
                </button>
              </div>
              <div className="schedule-line">
                <span className="schedule-icon">
                  {dinner ? (
                    <Utensils size={20} />
                  ) : lunch ? (
                    <Coffee size={20} />
                  ) : (
                    <Sun size={20} />
                  )}
                </span>
                <div>
                  <strong>
                    {summary.status === "rest"
                      ? "今天，给自己放个假"
                      : `${startTime} — ${nextEnd}`}
                  </strong>
                  <small title={mealSchedule || undefined}>
                    {summary.status === "completed"
                      ? "今日记录已保存，明天继续"
                      : mealBreak
                        ? `${dinner ? "晚饭" : "午休"}至 ${clockTime(activeMealEnd)}，期间不计薪`
                        : beforeStart
                          ? `${startTime} 自动开始计薪`
                          : summary.status === "paused"
                            ? "暂停期间不计薪，随时继续"
                            : mealSchedule
                              ? `${mealSchedule} · 自动扣除`
                              : "按实际工作时间计薪"}
                  </small>
                </div>
                <span className="hours-tag">
                  {(summary.plannedSeconds / 3600).toFixed(1).replace(".0", "")}
                  h
                </span>
              </div>
              <div className="work-actions">
                {working ? (
                  <>
                    <button
                      className="primary"
                      onClick={() => mutate(pauseWork)}
                    >
                      <Pause size={17} fill="currentColor" />
                      暂停计时
                    </button>
                    <button
                      className="finish-button"
                      title="结束今天的工作"
                      onClick={() => setConfirmFinish(true)}
                    >
                      <Flag size={16} />
                      下班
                    </button>
                  </>
                ) : summary.status === "completed" ? (
                  <button className="primary complete" disabled>
                    <Check size={18} />
                    今天辛苦了，好好休息
                  </button>
                ) : summary.status === "rest" ? (
                  <button
                    className="primary rest-button"
                    onClick={() => setView("calendar")}
                  >
                    <CalendarDays size={17} />
                    查看工作日历
                  </button>
                ) : (
                  <button className="primary" onClick={() => mutate(startWork)}>
                    <Play size={17} fill="currentColor" />
                    {summary.status === "paused" ? "继续工作" : "开始工作"}
                    <span>
                      {summary.status === "paused"
                        ? "让收入继续走"
                        : "开启今天的积累"}
                    </span>
                  </button>
                )}
              </div>
              <p className={`work-hint ${!currentPeriod.holidayCoverageComplete ? "holiday-estimate-hint" : ""}`}>
                {!currentPeriod.holidayCoverageComplete
                  ? <button onClick={() => setView("settings")} title="前往设置更新中国大陆节假日">
                      节假日尚未完整获取，工作日与发薪日暂为估算 <ChevronRight size={11} />
                    </button>
                  : summary.status === "completed"
                  ? "下班后停止计薪 · 跨天后可重新开始"
                  : summary.status === "rest"
                    ? "需要加班？在日历中将今天设为工作日"
                    : working
                      ? `${nextEnd} 自动结束计薪 · 收起窗口后继续记录`
                      : "点击后开始计薪 · 到下班时间自动结束"}
              </p>
            </section>

            <section className="month-section">
              <div className="section-label">
                <span>
                  <CalendarDays size={16} /> 本周期概览
                </span>
                <button className="text-button" onClick={() => openPayroll()}>
                  薪资周期 <ChevronRight size={13} />
                </button>
              </div>
              <div className="month-grid">
                <button className="stat-card" onClick={() => openPayroll()}>
                  <span>
                    周期工作日
                    <ArrowUpRight size={13} />
                  </span>
                  <strong>
                    {days}
                    <small>天</small>
                  </strong>
                  <span className="stat-foot">
                    已过 {elapsedWorkdays} 天 <i>·</i>{" "}
                    {modeNames[data.settings.scheduleMode]}
                  </span>
                </button>
                <button
                  className="stat-card"
                  onClick={() => setView("history")}
                >
                  <span>
                    周期已记录
                    <ArrowUpRight size={13} />
                  </span>
                  <strong className="month-money">
                    <small>¥</small>
                    {cash(
                      periodEarnings(
                        data,
                        currentPeriod.start,
                        currentPeriod.end,
                        now,
                      ),
                    )}
                  </strong>
                  <span className="stat-foot">
                    {
                      Object.keys(data.records).filter(
                        (k) =>
                          k >= currentPeriod.start && k <= currentPeriod.end,
                      ).length
                    }{" "}
                    天工作记录
                  </span>
                </button>
              </div>
            </section>
            <button
              className="salary-note payday-shortcut"
              title={
                nextPayday
                  ? `对应计薪周期：${periodRange(nextPayday)}`
                  : "查看发薪安排"
              }
              onClick={() => openPayroll(nextPayday?.start)}
            >
              <Wallet size={13} />
              {nextPayday
                ? `下次发薪 ${shortDate(nextPayday.actualPayday!)} · ${nextPayday.daysUntil === 0 ? "就是今天" : `还有 ${nextPayday.daysUntil} 天`}`
                : "查看发薪安排"}
              <ChevronRight size={12} />
            </button>
          </>
        )}

        {view === "settings" && (
          <SettingsPanel
            settings={data.settings}
            onBack={() => setView("home")}
            onSave={(settings) => {
              setData((current) =>
                current ? { ...current, settings } : current,
              );
              setView("home");
              setToast("设置已保存，已开始的工作记录保持原计薪标准");
            }}
          />
        )}
        {view === "calendar" && (
          <CalendarPanel
            settings={data.settings}
            now={now}
            onBack={() => setView("home")}
            onChange={(settings) => {
              setData((current) =>
                current ? { ...current, settings } : current,
              );
              setToast("日历已保存");
            }}
          />
        )}
        {view === "payroll" && (
          <PayrollPanel
            data={data}
            now={now}
            hidden={hidden}
            initialDate={payrollFocus}
            onBack={() => setView("home")}
            onSettings={() => setView("settings")}
            onCalendar={() => setView("calendar")}
          />
        )}
        {view === "history" && (
          <>
            <PanelTitle
              title="工作记录"
              subtitle="每一天的积累，都有迹可循"
              onBack={() => setView("home")}
            />
            <div className="history-total">
              <span>{periodRange(currentPeriod)} · 已记录</span>
              <strong>
                ¥
                {cash(
                  periodEarnings(
                    data,
                    currentPeriod.start,
                    currentPeriod.end,
                    now,
                  ),
                )}
              </strong>
            </div>
            <div className="history-list">
              {Object.keys(data.records)
                .filter(
                  (k) => k >= currentPeriod.start && k <= currentPeriod.end,
                )
                .sort()
                .reverse()
                .map((key) => {
                  const s = getDaySummary(
                    data,
                    key === today ? now : new Date(`${key}T23:59:59`).getTime(),
                  );
                  return (
                    <div className="history-row" key={key}>
                      <span className="history-icon">
                        <Clock3 size={17} />
                      </span>
                      <div>
                        <strong>{key.slice(5).replace("-", "月")}日</strong>
                        <small>
                          {duration(s.seconds)} ·{" "}
                          {s.status === "completed"
                            ? "已结束"
                            : s.status === "working"
                              ? "计时中"
                              : "已暂停"}
                        </small>
                      </div>
                      <strong>¥{cash(s.earnings)}</strong>
                    </div>
                  );
                })}
              {!Object.keys(data.records).some(
                (k) => k >= currentPeriod.start && k <= currentPeriod.end,
              ) && (
                <div className="empty-state">
                  <Coffee size={32} />
                  <strong>属于你的第一笔积累</strong>
                  <p>点击「开始工作」，这里就会留下记录。</p>
                </div>
              )}
            </div>
            <p className="panel-note">
              仅统计点击开始后的计薪时长；尚未打卡的日期不会补算。
            </p>
          </>
        )}
      </main>

      <footer className="app-footer">
        <span>
          <ShieldCheck size={12} />
          仅本地保存<span className="footer-dot">·</span>每秒更新
        </span>
        <button onClick={() => window.touchFish?.quit()} title="退出应用">
          <Power size={12} />
          退出
        </button>
      </footer>
      {toast && (
        <div className="toast" role="status">
          <Check size={14} />
          {toast}
        </div>
      )}
      {confirmFinish && (
        <div className="modal-backdrop">
          <div
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="finish-title"
          >
            <span className="dialog-icon">
              <Flag size={24} />
            </span>
            <h2 id="finish-title">今天就到这里？</h2>
            <p>
              今天已记录的 ¥{cash(summary.earnings)}{" "}
              会保留。下班后，今天将不能再次开始。
            </p>
            <div>
              <button
                className="secondary"
                onClick={() => setConfirmFinish(false)}
              >
                再工作一会
              </button>
              <button
                className="primary"
                onClick={() => {
                  mutate(finishWork);
                  setConfirmFinish(false);
                }}
              >
                确认下班
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PanelTitle({
  title,
  subtitle,
  onBack,
}: {
  title: string;
  subtitle: string;
  onBack: () => void;
}) {
  return (
    <div className="panel-title">
      <button className="icon-button" title="返回" onClick={onBack}>
        <ArrowLeft size={19} />
      </button>
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
    </div>
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function SettingsPanel({
  settings,
  onBack,
  onSave,
}: {
  settings: Settings;
  onBack: () => void;
  onSave: (s: Settings) => void;
}) {
  const [draft, setDraft] = useState<Settings>(() => structuredClone(settings));
  const [errors, setErrors] = useState<string[]>([]);
  const [login, setLogin] = useState(false);
  const [loginError, setLoginError] = useState("");
  useEffect(() => {
    window.touchFish
      ?.getLogin()
      .then(setLogin)
      .catch(() => setLoginError("无法读取开机启动状态"));
  }, []);
  const patch = (value: Partial<Settings>) =>
    setDraft((current) => ({ ...current, ...value }));
  const save = () => {
    const issues = validateSettings(draft);
    setErrors(issues);
    if (!issues.length) onSave(normalizeSettings(draft));
  };
  return (
    <>
      <PanelTitle
        title="偏好设置"
        subtitle="把工作节奏，设成你的样子"
        onBack={onBack}
      />
      <section className="settings-group">
        <h2>
          <Wallet size={15} />
          薪资与工作制
        </h2>
        <Field label="税前月薪">
          <div className="salary-input">
            <span>¥</span>
            <input
              aria-label="税前月薪"
              type="number"
              min="0"
              max="100000000"
              step="100"
              value={draft.monthlySalary || ""}
              placeholder="例如 15000"
              onChange={(e) => patch({ monthlySalary: Number(e.target.value) })}
            />
            <span>元 / 月</span>
          </div>
        </Field>
        <Field label="工作制度">
          <div className="segmented">
            {(["double", "single", "alternate"] as const).map((mode) => (
              <button
                className={draft.scheduleMode === mode ? "active" : ""}
                key={mode}
                onClick={() => patch({ scheduleMode: mode })}
              >
                {modeNames[mode]}
                {draft.scheduleMode === mode && <Check size={13} />}
              </button>
            ))}
          </div>
        </Field>
        {draft.scheduleMode !== "double" && (
          <Field
            label={
              draft.scheduleMode === "alternate"
                ? "单休周的休息日"
                : "每周休息日"
            }
          >
            <select
              value={draft.restDay}
              onChange={(e) => patch({ restDay: Number(e.target.value) })}
            >
              {weekdays.map((d, i) => (
                <option value={i} key={i}>
                  星期{d}
                </option>
              ))}
            </select>
          </Field>
        )}
        {draft.scheduleMode === "alternate" && (
          <Field
            label="双休周的周一"
            hint="这周休六、日，下一周按单休计算，依次交替。"
          >
            <input
              type="date"
              value={draft.alternateAnchor}
              onChange={(e) => patch({ alternateAnchor: e.target.value })}
            />
          </Field>
        )}
      </section>
      <PayrollSettings
        settings={draft}
        onChange={(payroll) => patch({ payroll })}
      />
      <section className="settings-group">
        <div className="switch-row">
          <div>
            <h2>
              <CalendarDays size={15} />
              排除公共假期
            </h2>
            <p>中国大陆官方假期不计工作日，调休补班计入</p>
          </div>
          <button
            role="switch"
            aria-label="排除公共假期"
            aria-checked={draft.publicHolidays}
            className={`switch ${draft.publicHolidays ? "on" : ""}`}
            onClick={() => patch({ publicHolidays: !draft.publicHolidays })}
          >
            <span />
          </button>
        </div>
        <HolidaySettings />
      </section>
      <section className="settings-group">
        <h2>
          <Clock3 size={15} />
          每周上下班时间
        </h2>
        <p className="group-hint">可单独设置每一天，例如周三 18:00 下班。</p>
        <div className="time-table">
          <div className="time-table-head">
            <span>星期</span>
            <span>上班</span>
            <span>下班</span>
          </div>
          {[1, 2, 3, 4, 5, 6, 0].map((day) => (
            <div className="time-row" key={day}>
              <span>周{weekdays[day]}</span>
              <input
                aria-label={`周${weekdays[day]}上班时间`}
                type="time"
                value={draft.weekdayHours[day].start}
                onChange={(e) =>
                  patch({
                    weekdayHours: {
                      ...draft.weekdayHours,
                      [day]: {
                        ...draft.weekdayHours[day],
                        start: e.target.value,
                      },
                    },
                  })
                }
              />
              <span className="time-dash">—</span>
              <input
                aria-label={`周${weekdays[day]}下班时间`}
                type="time"
                value={draft.weekdayHours[day].end}
                onChange={(e) =>
                  patch({
                    weekdayHours: {
                      ...draft.weekdayHours,
                      [day]: {
                        ...draft.weekdayHours[day],
                        end: e.target.value,
                      },
                    },
                  })
                }
              />
            </div>
          ))}
        </div>
        <p className="group-hint">
          休息日不会计薪，调休后使用该星期的时间。暂不支持跨夜班次。
        </p>
      </section>
      <MealSettings
        label="午休"
        icon={<Coffee size={15} />}
        value={draft.lunch}
        onChange={(lunch) => patch({ lunch })}
      />
      <MealSettings
        label="晚饭"
        icon={<Utensils size={15} />}
        value={draft.dinner}
        onChange={(dinner) => patch({ dinner })}
      />
      {window.touchFish && window.touchFish.platform !== "linux" && (
        <section className="settings-group">
          <div className="switch-row">
            <div>
              <h2>
                <Sparkles size={15} />
                开机启动
              </h2>
              <p>登录后静静等在系统托盘</p>
            </div>
            <button
              role="switch"
              aria-checked={login}
              aria-label="开机启动"
              className={`switch ${login ? "on" : ""}`}
              onClick={async () => {
                try {
                  await window.touchFish!.setLogin(!login);
                  setLogin(!login);
                  setLoginError("");
                } catch {
                  setLoginError("此系统暂不支持设置开机启动");
                }
              }}
            >
              <span />
            </button>
          </div>
          {loginError && <p className="field-error">{loginError}</p>}
        </section>
      )}
      <FloatingSettings />
      <UpdatePanel
        hasUnsavedSettings={JSON.stringify(draft) !== JSON.stringify(settings)}
      />
      <div className="formula-note">
        <CircleHelp size={16} />
        <p>
          日薪 = 月薪 ÷ 计薪周期工作日
          <br />
          秒薪 = 日薪 ÷ 当天计薪秒数
          <br />
          <span>
            当天首次开始时锁定计薪标准；修改设置从尚未开始的日期生效。金额为税前估算。
          </span>
        </p>
      </div>
      {errors.length > 0 && (
        <div className="validation-errors" role="alert">
          {errors.map((e) => (
            <p key={e}>{e}</p>
          ))}
        </div>
      )}
      <div className="settings-save">
        <button className="secondary" onClick={onBack}>
          取消
        </button>
        <button className="primary" onClick={save}>
          <Check size={16} />
          保存设置
        </button>
      </div>
    </>
  );
}

function MealSettings({
  label,
  icon,
  value,
  onChange,
}: {
  label: "午休" | "晚饭";
  icon: ReactNode;
  value: Settings["lunch"];
  onChange: (value: Settings["lunch"]) => void;
}) {
  return (
    <section className="settings-group">
      <div className="switch-row">
        <div>
          <h2>
            {icon}扣除{label}
          </h2>
          <p>仅在工作时段内扣除，结束后自动恢复计薪</p>
        </div>
        <button
          role="switch"
          aria-label={`扣除${label}`}
          aria-checked={value.enabled}
          className={`switch ${value.enabled ? "on" : ""}`}
          onClick={() => onChange({ ...value, enabled: !value.enabled })}
        >
          <span />
        </button>
      </div>
      {value.enabled && (
        <div className="lunch-inputs">
          <input
            aria-label={`${label}开始`}
            type="time"
            value={value.start}
            onChange={(e) => onChange({ ...value, start: e.target.value })}
          />
          <span>至</span>
          <input
            aria-label={`${label}结束`}
            type="time"
            value={value.end}
            onChange={(e) => onChange({ ...value, end: e.target.value })}
          />
        </div>
      )}
    </section>
  );
}

function CalendarPanel({
  settings,
  now,
  onBack,
  onChange,
}: {
  settings: Settings;
  now: number;
  onBack: () => void;
  onChange: (s: Settings) => void;
}) {
  const date = new Date(now);
  const [cursor, setCursor] = useState([
    date.getFullYear(),
    date.getMonth() + 1,
  ]);
  const [year, month] = cursor;
  useHolidayYears([year, year + 1], settings.publicHolidays);
  const [selected, setSelected] = useState(dateKey(now));
  const days = monthDays(year, month, settings);
  const offset = (new Date(year, month - 1, 1).getDay() + 6) % 7;
  const shift = (n: number) => {
    const d = new Date(year, month - 1 + n, 1);
    setCursor([d.getFullYear(), d.getMonth() + 1]);
    setSelected(dateKey(d));
  };
  const override = settings.overrides[selected];
  const selectedHoliday = settings.publicHolidays
    ? getPublicHoliday(selected)
    : null;
  const availableHolidayYears = getHolidayYears();
  const hasHolidayData = availableHolidayYears.includes(year) &&
    (month !== 12 || availableHolidayYears.includes(year + 1));
  const update = (mode: "work" | "rest" | undefined) => {
    const overrides = { ...settings.overrides };
    if (mode) overrides[selected] = mode;
    else delete overrides[selected];
    onChange({ ...settings, overrides });
  };
  return (
    <>
      <PanelTitle
        title="工作日历"
        subtitle="安排好忙碌，也安排好休息"
        onBack={onBack}
      />
      <div className="calendar-navigation">
        <button
          className="icon-button"
          title="上个月"
          onClick={() => shift(-1)}
        >
          <ChevronLeft size={18} />
        </button>
        <h2>
          {year}年 {month}月
        </h2>
        <button className="icon-button" title="下个月" onClick={() => shift(1)}>
          <ChevronRight size={18} />
        </button>
      </div>
      <div className="calendar-summary">
        <span>
          本月工作 <strong>{days.filter((d) => d.working).length}</strong> 天
        </span>
        <span>
          休息 <strong>{days.filter((d) => !d.working).length}</strong> 天
        </span>
        <span className="mode-tag">{modeNames[settings.scheduleMode]}</span>
      </div>
      <div className="calendar-grid">
        {["一", "二", "三", "四", "五", "六", "日"].map((d) => (
          <span className="calendar-weekday" key={d}>
            {d}
          </span>
        ))}
        {Array.from({ length: offset }, (_, i) => (
          <span key={`blank-${i}`} />
        ))}
        {days.map((d) => (
          <button
            key={d.date}
            aria-label={`${d.date} ${d.working ? "工作日" : "休息日"}`}
            aria-pressed={selected === d.date}
            title={
              settings.publicHolidays
                ? getPublicHoliday(d.date)?.name
                : undefined
            }
            className={`calendar-day ${d.working ? "work" : "rest"} ${selected === d.date ? "chosen" : ""} ${d.date === dateKey(now) ? "today" : ""}`}
            onClick={() => setSelected(d.date)}
          >
            <span>{Number(d.date.slice(8))}</span>
            <small>
              {settings.overrides[d.date]
                ? d.working
                  ? "班"
                  : "休"
                : settings.publicHolidays && getPublicHoliday(d.date)
                  ? getPublicHoliday(d.date)!.kind === "rest"
                    ? "假"
                    : "班"
                  : d.date === dateKey(now)
                    ? "今天"
                    : d.working
                      ? "·"
                      : "休"}
            </small>
          </button>
        ))}
      </div>
      <div className="calendar-legend">
        <span>
          <i />
          工作日
        </span>
        <span>
          <i />
          休息日
        </span>
        <span>点击日期调整排班</span>
      </div>
      <section className="override-panel">
        <h3>
          {selected.replaceAll("-", ".")}{" "}
          <span>{isWorkday(selected, settings) ? "工作日" : "休息日"}</span>
        </h3>
        {selectedHoliday && (
          <p className="holiday-day-note">
            {selectedHoliday.name} ·{" "}
            {selectedHoliday.kind === "rest" ? "官方放假" : "调休补班"}
            {override ? " · 已手动调整" : ""}
          </p>
        )}
        <div className="segmented">
          <button
            className={!override ? "active" : ""}
            onClick={() => update(undefined)}
          >
            跟随安排
          </button>
          <button
            className={override === "work" ? "active" : ""}
            onClick={() => update("work")}
          >
            设为工作
          </button>
          <button
            className={override === "rest" ? "active" : ""}
            onClick={() => update("rest")}
          >
            设为休息
          </button>
        </div>
      </section>
      <p className="panel-note">
        {settings.publicHolidays
          ? hasHolidayData
            ? `已应用中国大陆 ${year} 年官方放假与补班安排，手动调整优先。`
            : `${year} 年及相关跨年节假日数据尚未完整获取或未公布，暂按已有数据与工作制估算，可在设置中更新或手动调整。`
          : "已关闭公共假期，当前按工作制及手动调整计算。"}
        已开始的记录保留当天原有计薪标准。
      </p>
    </>
  );
}

export default App;

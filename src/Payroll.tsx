import { useMemo, useState } from "react";
import {
  ArrowLeft,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Settings2,
  Wallet,
} from "lucide-react";
import {
  dateKey,
  getPayrollPeriod,
  getRecordSummary,
  periodEarnings,
  shiftPayrollPeriod,
  type AppData,
  type PayrollPeriod,
  type Settings,
} from "./core";
import { useHolidayState, useHolidayYears, yearsForDates } from "./holiday-client";

export const shortDate = (key: string) =>
  `${Number(key.slice(5, 7))}月${Number(key.slice(8))}日`;
export const periodRange = (period: Pick<PayrollPeriod, "start" | "end">) =>
  `${period.start.replaceAll("-", ".")} — ${period.end.replaceAll("-", ".")}`;
const money = (n: number) =>
  n.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
const adjustmentText = (period: PayrollPeriod, policy: Settings["payroll"]["holidayAdjustment"]) =>
  !period.actualPayday
    ? "一年内没有可用工作日，请检查排班"
    : policy === "none"
      ? "按计划日期发薪，节假日和休息日不调整"
      : period.adjustmentDays === 0
      ? "当天为工作日，无需调整"
      : `${period.adjustmentDays < 0 ? "提前" : "顺延"} ${Math.abs(period.adjustmentDays)} 天，避开非工作日`;

export function PayrollSettings({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (payroll: Settings["payroll"]) => void;
}) {
  useHolidayState();
  const payroll = settings.payroll;
  const preview = getPayrollPeriod(dateKey(), settings);
  useHolidayYears(yearsForDates(preview.start, preview.end, preview.nominalPayday,
    preview.actualPayday), settings.publicHolidays);
  const patch = (change: Partial<Settings["payroll"]>) =>
    onChange({ ...payroll, ...change });
  const days = Array.from({ length: 31 }, (_, index) => index + 1);
  return (
    <section className="settings-group payroll-settings">
      <h2>
        <Wallet size={15} />
        计薪周期与发薪日
      </h2>
      <label className="field">
        <span>每月计薪起始日</span>
        <select
          aria-label="每月计薪起始日"
          value={payroll.cycleStartDay}
          onChange={(e) => patch({ cycleStartDay: Number(e.target.value) })}
        >
          {days.map((day) => (
            <option value={day} key={day}>
              {day} 日{day === 1 ? "（自然月）" : ""}
            </option>
          ))}
        </select>
        <small>
          从该日开始，至下个月起始日前一天。短月没有该日期时取月底。
        </small>
      </label>
      <div className="payroll-setting-grid">
        <label className="field">
          <span>发薪月份</span>
          <select
            aria-label="发薪月份"
            value={payroll.payMonthOffset}
            onChange={(e) =>
              patch({ payMonthOffset: Number(e.target.value) as 0 | 1 | 2 })
            }
          >
            <option value={0}>周期结束当月</option>
            <option value={1}>周期结束次月</option>
            <option value={2}>周期结束隔月</option>
          </select>
        </label>
        <label className="field">
          <span>每月发薪日</span>
          <select
            aria-label="每月发薪日"
            value={payroll.payDay}
            onChange={(e) => patch({ payDay: Number(e.target.value) })}
          >
            {days.map((day) => (
              <option value={day} key={day}>
                {day} 日
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="field">
        <span>遇非工作日的处理</span>
        <div className="segmented payday-policy" role="group" aria-label="遇非工作日的处理">
          <button
            aria-label="提前到最近工作日"
            aria-pressed={payroll.holidayAdjustment === "previous"}
            className={payroll.holidayAdjustment === "previous" ? "active" : ""}
            onClick={() => patch({ holidayAdjustment: "previous" })}
          >
            提前发薪
          </button>
          <button
            aria-label="顺延到最近工作日"
            aria-pressed={payroll.holidayAdjustment === "next"}
            className={payroll.holidayAdjustment === "next" ? "active" : ""}
            onClick={() => patch({ holidayAdjustment: "next" })}
          >
            顺延发薪
          </button>
          <button
            aria-label="当天发薪"
            aria-pressed={payroll.holidayAdjustment === "none"}
            className={payroll.holidayAdjustment === "none" ? "active" : ""}
            onClick={() => patch({ holidayAdjustment: "none" })}
          >
            当天发薪
          </button>
        </div>
        <small>
          {payroll.holidayAdjustment === "none"
            ? "按计划日期照常发薪，遇公共假期或休息日也不移动。短月没有指定日期时，仍取当月最后一天。"
            : "提前或顺延至最近工作日，周休、公共假期、调休补班和手动排班均参与判断。发薪日不存在时先取当月最后一天。"}
        </small>
      </div>
      <div className="payroll-preview">
        <span>当前周期预览</span>
        <strong>{periodRange(preview)}</strong>
        <span>
          {preview.workdays} 个工作日 · 计划 {shortDate(preview.nominalPayday)}{" "}
          发薪
        </span>
        <strong>
          调整后：
          {preview.actualPayday
            ? preview.actualPayday.replaceAll("-", ".")
            : "暂无可用日期"}
        </strong>
        <span>{adjustmentText(preview, payroll.holidayAdjustment)}</span>
      </div>
      {payroll.payMonthOffset === 0 && preview.nominalPayday < preview.end && (
        <p className="holiday-coverage">
          此设置的发薪日早于周期结束日，属于预发安排。
        </p>
      )}
      {!preview.holidayCoverageComplete && (
        <p className="payroll-warning">
          {payroll.holidayAdjustment === "none"
            ? "部分日期的节假日尚未获取或未公布，周期工作日和参考日薪暂为估算；发薪日期按计划保留。"
            : "部分日期的节假日尚未获取或未公布，发薪日暂按已有排班估算。"}
        </p>
      )}
    </section>
  );
}

export function PayrollPanel({
  data,
  now,
  hidden,
  initialDate,
  onBack,
  onSettings,
  onCalendar,
}: {
  data: AppData;
  now: number;
  hidden: boolean;
  initialDate?: string;
  onBack: () => void;
  onSettings: () => void;
  onCalendar: () => void;
}) {
  const holidayState = useHolidayState();
  const today = dateKey(now);
  const [cursor, setCursor] = useState(initialDate || today);
  const period = useMemo(
    () => getPayrollPeriod(cursor, data.settings),
    [cursor, data.settings, holidayState.years],
  );
  useHolidayYears(yearsForDates(period.start, period.end, period.nominalPayday,
    period.actualPayday), data.settings.publicHolidays);
  const current = getPayrollPeriod(today, data.settings);
  const keys = Object.keys(data.records)
    .filter((key) => key >= period.start && key <= period.end)
    .sort()
    .reverse();
  const cash = (amount: number) => (hidden ? "••••" : money(amount));
  const shift = (delta: number) =>
    setCursor(shiftPayrollPeriod(period, delta, data.settings).start);
  return (
    <>
      <div className="panel-title">
        <button className="icon-button" title="返回" onClick={onBack}>
          <ArrowLeft size={19} />
        </button>
        <div>
          <h1>薪资周期</h1>
          <p>查看每个周期的积累与发薪安排</p>
        </div>
        <button
          className="icon-button payroll-settings-button"
          title="修改薪资设置"
          onClick={onSettings}
        >
          <Settings2 size={18} />
        </button>
      </div>
      <div className="payroll-navigation">
        <button
          className="icon-button"
          title="上个周期"
          onClick={() => shift(-1)}
        >
          <ChevronLeft size={18} />
        </button>
        <div>
          <strong>
            {Number(period.end.slice(0, 4))}年 {Number(period.end.slice(5, 7))}
            月周期
          </strong>
          <span className="payroll-range">{periodRange(period)}</span>
        </div>
        <button
          className="icon-button"
          title="下个周期"
          onClick={() => shift(1)}
        >
          <ChevronRight size={18} />
        </button>
      </div>
      {period.start !== current.start && (
        <button
          className="text-button return-current"
          onClick={() => setCursor(today)}
        >
          回到当前周期
        </button>
      )}
      <section className="payroll-total">
        <span>
          该周期已记录 <small>税前</small>
        </span>
        <strong>
          ¥{cash(periodEarnings(data, period.start, period.end, now))}
        </strong>
        <div>
          <span>{period.workdays} 个工作日</span>
          <span>{keys.length} 天工作记录</span>
        </div>
      </section>
      <section className="payday-card">
        <h2>
          <Wallet size={15} />
          本周期发薪安排
        </h2>
        <div className="payday-row">
          <span>计划发薪日</span>
          <strong className="payday-nominal">
            {period.nominalPayday.replaceAll("-", ".")}
          </strong>
        </div>
        <div className="payday-row">
          <span>调整后发薪日</span>
          <strong className="payday-actual">
            {period.actualPayday
              ? period.actualPayday.replaceAll("-", ".")
              : "暂无可用日期"}
          </strong>
        </div>
        <p>{adjustmentText(period, data.settings.payroll.holidayAdjustment)}</p>
        {period.actualPayday && period.actualPayday < today && (
          <small>计划日期已过；此处不代表工资已经到账。</small>
        )}
        {!period.holidayCoverageComplete && (
          <div className="payroll-warning">
            {data.settings.payroll.holidayAdjustment === "none"
              ? "部分年份尚无官方节假日数据，周期工作日和参考日薪暂为估算；发薪日期按计划保留。"
              : "部分年份尚无官方节假日数据，日期暂按已有排班估算。"}
          </div>
        )}
      </section>
      <div className="payroll-reference">
        <span>
          当前设置估算月薪 <strong>¥{cash(data.settings.monthlySalary)}</strong>
        </span>
        <span>
          参考日薪{" "}
          <strong>
            ¥
            {cash(
              period.workdays > 0
                ? data.settings.monthlySalary / period.workdays
                : 0,
            )}
          </strong>
        </span>
      </div>
      <div className="section-label payroll-records-heading">
        <span>
          <Clock3 size={15} />
          周期工作记录
        </span>
        <button className="text-button" onClick={onCalendar}>
          工作日历 <ChevronRight size={13} />
        </button>
      </div>
      {keys.length ? (
        <div className="history-list">
          {keys.map((key) => {
            const summary = getRecordSummary(data, key, now);
            return (
              <div className="history-row" key={key}>
                <span className="history-icon">
                  <CalendarDays size={17} />
                </span>
                <div>
                  <strong>{shortDate(key)}</strong>
                  <small>
                    {(summary.seconds / 3600).toFixed(2)} 小时 ·{" "}
                    {summary.status === "completed"
                      ? "已结束"
                      : summary.status === "working"
                        ? "计时中"
                        : "已暂停"}
                  </small>
                </div>
                <strong>¥{cash(summary.earnings)}</strong>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="payroll-empty">这个周期还没有工作记录</div>
      )}
      <p className="panel-note">
        按选定周期汇总；计薪时长保留实际记录，已结束日期按原日目标结算。已开始的记录保留原日目标与秒薪，更改周期不重定价。
      </p>
    </>
  );
}

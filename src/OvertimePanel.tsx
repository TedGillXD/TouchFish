import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Clock3, Pencil, Play, Plus, Square, Trash2 } from "lucide-react";
import {
  OVERTIME_MULTIPLIERS,
  overtimePay,
  overtimeSeconds,
  type OvertimeData,
  type OvertimeEntry,
  type OvertimeInput,
  type OvertimeKind,
} from "./overtime";
import "./overtime.css";

type Result = string | void;
type Mode = "timer" | "manual";
type StartInput = Pick<OvertimeInput, "kind" | "monthlyBase">;

interface Props {
  overtime: OvertimeData;
  defaultBase: number;
  today: string;
  now: number;
  hidden: boolean;
  startDisabledReason: string | null;
  getDateHint: (date: string) => string;
  onBaseChange: (base: number | null) => Result;
  onStart: (input: StartInput) => Result;
  onStop: () => Result;
  onSave: (input: OvertimeInput, id?: string) => Result;
  onDelete: (id: string) => Result;
}

const kindNames: Record<OvertimeKind, string> = {
  weekday: "工作日延时",
  rest: "休息日加班",
  statutory: "法定节假日加班",
};
const kinds: OvertimeKind[] = ["weekday", "rest", "statutory"];
const currency = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" });
const amount = (value: number, hidden: boolean) => hidden ? "金额已隐藏" : currency.format(value);
const hours = (seconds: number) => Math.floor(seconds / 3600);
const minutes = (seconds: number) => Math.floor(seconds / 60) % 60;
const durationLabel = (seconds: number) => [hours(seconds), minutes(seconds), seconds % 60]
  .map(part => String(part).padStart(2, "0")).join(":");
const percentage = (kind: OvertimeKind) => `${OVERTIME_MULTIPLIERS[kind] * 100}%`;
const pageSize = 12;

function parseBase(input: string): number | null {
  const value = input.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) return null;
  const amount = Number(value);
  return amount <= 1e9 ? amount : null;
}

function MoneyInput({ label, value, onChange, hidden, placeholder }: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  hidden: boolean;
  placeholder?: string;
}) {
  return <input aria-label={label} type={hidden ? "password" : "text"} inputMode="decimal"
    value={value} onChange={event => onChange(event.target.value)} maxLength={16}
    placeholder={placeholder} autoComplete="off" />;
}

type DurationDraft = [string, string, string];
const splitDuration = (seconds: number): DurationDraft =>
  [hours(seconds), minutes(seconds), seconds % 60].map(part => part ? String(part) : "") as DurationDraft;

function readDuration(values: DurationDraft): number | null {
  if (values.some(value => value && !/^\d{1,2}$/.test(value))) return null;
  const [h, m, s] = values.map(Number);
  if (h > 24 || m > 59 || s > 59) return null;
  const seconds = h * 3600 + m * 60 + s;
  return seconds <= 24 * 3600 ? seconds : null;
}

function DurationFields({ label, value, setValue }: {
  label: string;
  value: DurationDraft;
  setValue: (value: DurationDraft) => void;
}) {
  return (
    <fieldset className="field overtime-duration">
      <legend>{label}</legend>
      <div className="overtime-duration-fields">
        {(["时", "分", "秒"] as const).map((unit, index) => (
          <label key={unit}>
            <input aria-label={`${label}（${unit}）`} inputMode="numeric" type="text" maxLength={2}
              value={value[index]} placeholder="0" onChange={event => {
                const next: DurationDraft = [...value];
                next[index] = event.target.value;
                setValue(next);
              }} />
            <span>{unit}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function BaseSettings({ overtime, defaultBase, hidden, onBaseChange }: Pick<Props,
  "overtime" | "defaultBase" | "hidden" | "onBaseChange">) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");
  const monthlyBase = overtime.monthlyBase ?? defaultBase;

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft === null) return;
    const next = parseBase(draft);
    if (draft.trim() && next === null) {
      setError("请输入有效的月工资基数，最多保留两位小数。");
      return;
    }
    const result = onBaseChange(next);
    setError(result || "");
    if (!result) setDraft(null);
  }

  return (
    <div className="overtime-base">
      <div>
        <span>默认月工资基数</span>
        <strong>{amount(monthlyBase, hidden)}</strong>
        {overtime.monthlyBase === null && <small>沿用税前月薪估算</small>}
      </div>
      {draft === null ? <button className="text-button" type="button" onClick={() => {
        setDraft(overtime.monthlyBase === null ? "" : String(overtime.monthlyBase));
        setError("");
      }}>设置加班基数</button> : (
        <form onSubmit={save} className="overtime-base-form">
          <label className="field">
            <span>默认加班月工资基数（元）</span>
            <MoneyInput label="默认加班月工资基数" value={draft} onChange={setDraft}
              hidden={hidden} placeholder="留空沿用税前月薪" />
            <small>按适用的正常工作时间月工资基数填写。设定后用于新记录。</small>
          </label>
          {error && <p className="field-error" role="alert">{error}</p>}
          <div className="overtime-actions">
            <button className="secondary" type="button" onClick={() => setDraft(null)}>取消</button>
            <button className="primary" type="submit">保存基数</button>
          </div>
        </form>
      )}
    </div>
  );
}

function OvertimeForm({ mode, entry, today, now, monthlyBase, hidden, startDisabledReason,
  getDateHint, onStart, onSave, onCancel, onSaved }: Pick<Props,
  "today" | "now" | "hidden" | "startDisabledReason" | "getDateHint" | "onStart" | "onSave"> & {
  mode: Mode;
  entry?: OvertimeEntry;
  monthlyBase: number;
  onCancel: () => void;
  onSaved: (message: string) => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const manual = mode === "manual";
  const [date, setDate] = useState(entry?.date ?? today);
  const [kind, setKind] = useState<OvertimeKind | "">(entry?.kind ?? "");
  const [base, setBase] = useState<string | null>(null);
  const [duration, setDuration] = useState(() => splitDuration(entry?.seconds ?? 0));
  const [rest, setRest] = useState(() => splitDuration(entry?.compensatedSeconds ?? 0));
  const [error, setError] = useState("");
  const suggestedBase = entry?.monthlyBase ?? monthlyBase;
  const baseValue = base ?? String(suggestedBase);
  const seconds = readDuration(duration);
  const compensatedSeconds = kind === "rest" ? readDuration(rest) : 0;
  const selectedBase = base === null ? suggestedBase : parseBase(baseValue);
  const dateHint = manual ? date && getDateHint(date) : getDateHint(today);
  const preview = manual && kind && seconds && compensatedSeconds !== null && compensatedSeconds <= seconds && selectedBase !== null
    ? overtimePay({ id: "", date, kind, monthlyBase: selectedBase, seconds, compensatedSeconds, startedAt: null, endsAt: null }, now)
    : null;

  useEffect(() => {
    if (!entry) return;
    form.current?.scrollIntoView({ block: "start" });
    form.current?.querySelector("input")?.focus({ preventScroll: true });
  }, [entry?.id]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!kind) { setError("请选择加班类型。"); return; }
    if (selectedBase === null) { setError("请输入有效的月工资基数，最多保留两位小数。"); return; }
    if (!manual) {
      const result = onStart({ kind, monthlyBase: selectedBase });
      setError(result || "");
      if (!result) onSaved("已开始加班计时。");
      return;
    }
    if (!date || date > today) { setError("请选择今天或更早的日期。"); return; }
    if (!seconds) { setError("请输入有效的实际加班时长，最多 24 小时。"); return; }
    if (compensatedSeconds === null || compensatedSeconds > seconds) {
      setError("已补休时长不能超过实际加班时长。");
      return;
    }
    const input = { date, kind, monthlyBase: selectedBase, seconds, compensatedSeconds };
    const result = onSave(input, entry?.id);
    setError(result || "");
    if (!result) onSaved(entry ? "已更新加班记录。" : "已保存加班记录。");
  }

  return (
    <form className="overtime-form" ref={form} onSubmit={submit}>
      {entry && <h2>编辑加班记录</h2>}
      {manual && <label className="field">
        <span>加班日期</span>
        <input aria-label="加班日期" type="date" value={date} min="1900-01-01" max={today}
          onChange={event => { setDate(event.target.value); setKind(""); }} required />
      </label>}
      <label className="field">
        <span>加班类型</span>
        <select aria-label="加班类型" value={kind} onChange={event => setKind(event.target.value as OvertimeKind | "")}>
          <option value="">请选择加班类型</option>
          {kinds.map(item => <option key={item} value={item}>{kindNames[item]} · {percentage(item)}</option>)}
        </select>
        {dateHint && <small>{dateHint}</small>}
      </label>
      {manual && <>
        <DurationFields label="实际加班时长" value={duration} setValue={setDuration} />
        {kind === "rest" && <DurationFields label="已补休时长" value={rest} setValue={setRest} />}
        <label className="field">
          <span>本笔加班月工资基数（元）</span>
          <MoneyInput label="本笔加班月工资基数" value={baseValue} onChange={setBase} hidden={hidden} />
        </label>
      </>}
      {preview !== null && <div className="overtime-estimate"><span>预估加班费</span><strong>{amount(preview, hidden)}</strong></div>}
      {error && <p className="field-error" role="alert">{error}</p>}
      {!manual && <p className="overtime-note">计时按实际经过时间计算。休息时请结束计时，返回后再开始。</p>}
      {!manual && startDisabledReason && <p className="overtime-note">{startDisabledReason}</p>}
      <div className="overtime-actions">
        {entry && <button type="button" className="secondary" onClick={onCancel}>取消编辑</button>}
        <button type="submit" className="primary" disabled={!manual && !!startDisabledReason}>
          {manual ? <Plus size={13} /> : <Play size={13} />}
          {manual ? "保存加班" : "开始加班"}
        </button>
      </div>
    </form>
  );
}

export default function OvertimePanel(props: Props) {
  const { overtime, defaultBase, today, now, hidden, onStop, onDelete } = props;
  const [mode, setMode] = useState<Mode>("timer");
  const [editing, setEditing] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [pageLimit, setPageLimit] = useState(pageSize);
  const [formVersion, setFormVersion] = useState(0);
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const live = overtime.entries.find(entry => entry.startedAt !== null);
  const rows = useMemo(() => overtime.entries.filter(entry => entry.startedAt === null)
    .sort((a, b) => b.date.localeCompare(a.date)), [overtime.entries]);
  const entry = rows.find(row => row.id === editing);

  function perform(operation: () => Result, message: string) {
    const result = operation();
    setActionError(result || "");
    setNotice(result ? "" : message);
    return !result;
  }

  function switchMode(next: Mode) {
    setMode(next);
    setEditing(null);
    setPendingDelete(null);
    setNotice("");
    setActionError("");
  }

  return (
    <section className="overtime-panel" aria-label="加班计算与记录">
      {live && <section className="overtime-live" aria-label="正在加班">
        <div className="overtime-live-head"><span><Clock3 size={14} />正在加班</span><span>{kindNames[live.kind]} · {percentage(live.kind)}</span></div>
        <div className="overtime-live-metrics">
          <strong aria-label="当前加班时长">{durationLabel(overtimeSeconds(live, now))}</strong>
          <strong aria-label="当前加班费">{amount(overtimePay(live, now), hidden)}</strong>
        </div>
        <div className="overtime-live-foot">
          <small>到当日午夜或记录上限时自动结束</small>
          <button className="secondary" type="button" onClick={() => perform(onStop, "已结束加班计时。")}>
            <Square size={12} />结束加班
          </button>
        </div>
      </section>}

      <section className="settings-group overtime-card" aria-label="记录加班">
        <div className="segmented overtime-mode" role="group" aria-label="记录方式">
          <button type="button" className={mode === "timer" ? "active" : ""} aria-pressed={mode === "timer"}
            onClick={() => switchMode("timer")}><Clock3 size={13} />实时计时</button>
          <button type="button" className={mode === "manual" ? "active" : ""} aria-pressed={mode === "manual"}
            onClick={() => switchMode("manual")}><Pencil size={12} />补录加班</button>
        </div>
        {(!live || mode === "manual") && <OvertimeForm
          key={`${mode}-${entry?.id ?? (mode === "timer" ? today : formVersion)}`}
          mode={mode} entry={entry} today={today} now={now} hidden={hidden}
          monthlyBase={overtime.monthlyBase ?? defaultBase} startDisabledReason={props.startDisabledReason}
          getDateHint={props.getDateHint} onStart={props.onStart} onSave={props.onSave}
          onCancel={() => { setEditing(null); setNotice(""); }}
          onSaved={message => {
            setEditing(null);
            setFormVersion(previous => previous + 1);
            setActionError("");
            setNotice(message);
          }} />}
        <BaseSettings overtime={overtime} defaultBase={defaultBase} hidden={hidden} onBaseChange={props.onBaseChange} />
      </section>

      {actionError && <p className="validation-errors overtime-feedback" role="alert">{actionError}</p>}
      {notice && <p className="overtime-feedback overtime-success" role="status">{notice}</p>}

      <section className="overtime-history" aria-label="加班记录">
        <h2>加班记录</h2>
        {rows.length === 0 && <p className="overtime-note">还没有已结束的加班记录。</p>}
        {rows.slice(0, pageLimit).map(row => (
          <article className="overtime-record" key={row.id}>
            <div className="overtime-record-main">
              <div>
                <strong>{row.date}</strong>
                <small>{kindNames[row.kind]} · {durationLabel(row.seconds)}{row.compensatedSeconds > 0 && ` · 补休 ${durationLabel(row.compensatedSeconds)}`}</small>
              </div>
              <strong className="overtime-record-pay">{amount(overtimePay(row, now), hidden)}</strong>
            </div>
            {pendingDelete === row.id ? <div className="overtime-record-actions" role="group" aria-label="确认删除加班记录">
              <span>删除这笔加班记录？</span>
              <button className="text-button" type="button" onClick={() => setPendingDelete(null)}>取消</button>
              <button className="text-button overtime-danger" type="button" onClick={() => {
                if (perform(() => onDelete(row.id), "已删除加班记录。")) {
                  setPendingDelete(null);
                  if (editing === row.id) setEditing(null);
                }
              }}>确认删除</button>
            </div> : <div className="overtime-record-actions">
              <button className="text-button" type="button" aria-label={`编辑加班 ${row.date}`} onClick={() => {
                switchMode("manual");
                setEditing(row.id);
                setFormVersion(previous => previous + 1);
              }}><Pencil size={12} />编辑</button>
              <button className="text-button overtime-danger" type="button" aria-label={`删除加班 ${row.date}`}
                onClick={() => { setPendingDelete(row.id); setNotice(""); setActionError(""); }}><Trash2 size={12} />删除</button>
            </div>}
          </article>
        ))}
        {rows.length > pageLimit && <button className="text-button overtime-more" type="button"
          onClick={() => setPageLimit(count => count + pageSize)}>显示更多加班记录</button>}
      </section>

      <details className="overtime-rules">
        <summary>加班费计算依据</summary>
        <p>按中国大陆标准工时制法定最低倍率估算。小时工资＝月工资基数 ÷ 21.75 ÷ 8。</p>
        <p>工作日延时按 150%，休息日未补休的时长按 200%，法定节假日当天按 300%。节日连休中的调休日按当天实际排班确认类型。</p>
        <small>《劳动法》第四十四条 · 人社部发〔2025〕2 号</small>
      </details>
    </section>
  );
}

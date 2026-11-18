/** Overtime estimates for standard working hours in mainland China. */
export const OVERTIME_MULTIPLIERS = {
  weekday: 1.5,
  rest: 2,
  statutory: 3,
} as const;

export type OvertimeKind = keyof typeof OVERTIME_MULTIPLIERS;

export interface OvertimeInput {
  date: string;
  kind: OvertimeKind;
  monthlyBase: number;
  seconds: number;
  compensatedSeconds: number;
}

export interface OvertimeEntry extends OvertimeInput {
  id: string;
  /** Two non-null timestamps describe a live recording. */
  startedAt: number | null;
  endsAt: number | null;
}

export interface OvertimeData {
  /** Null uses the current monthly wage as the suggested base for new records. */
  monthlyBase: number | null;
  entries: OvertimeEntry[];
}

const DAY_SECONDS = 24 * 60 * 60;
const MAX_ENTRIES = 10_000;
const MONTHLY_PAID_DAYS = 21.75;
const STANDARD_DAY_HOURS = 8;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?:19|20|21|22)\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map(value => String(value).padStart(2, "0"))
    .join("-");
}

function validKind(value: unknown): value is OvertimeKind {
  return value === "weekday" || value === "rest" || value === "statutory";
}

function validBase(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e9;
}

function validSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= DAY_SECONDS;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15;
}

function live(entry: OvertimeEntry): entry is OvertimeEntry & { startedAt: number; endsAt: number } {
  return entry.startedAt !== null && entry.endsAt !== null;
}

function reservedSeconds(entry: OvertimeEntry): number {
  return live(entry) ? Math.floor((entry.endsAt - entry.startedAt) / 1000) : entry.seconds;
}

export function emptyOvertime(): OvertimeData {
  return { monthlyBase: null, entries: [] };
}

/** Validate persisted and imported overtime independently of the reading device's timezone. */
export function parseOvertime(value: unknown): OvertimeData {
  if (value === undefined) return emptyOvertime();
  const invalid = () => new Error("加班数据格式不正确。");
  if (!object(value) || (value.monthlyBase !== null && !validBase(value.monthlyBase)) ||
    !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) throw invalid();

  const ids = new Set<string>();
  const secondsByDate = new Map<string, number>();
  let foundLive = false;
  const entries = Array.from(value.entries, (input): OvertimeEntry => {
    if (!object(input)) throw invalid();
    const { id, date, kind, monthlyBase, seconds, compensatedSeconds, startedAt, endsAt } = input;
    if (typeof id !== "string" || !/^[a-z0-9_-]{1,80}$/i.test(id) || ids.has(id) || !validDate(date) ||
      !validKind(kind) || !validBase(monthlyBase) || !validSeconds(seconds) || !validSeconds(compensatedSeconds) ||
      compensatedSeconds > seconds || (kind !== "rest" && compensatedSeconds !== 0)) throw invalid();

    if (startedAt === null && endsAt === null) {
      if (seconds === 0) throw invalid();
    } else {
      if (foundLive || seconds !== 0 || !validTimestamp(startedAt) || !validTimestamp(endsAt) ||
        endsAt - startedAt < 1000 || endsAt - startedAt > DAY_SECONDS * 1000) throw invalid();
      foundLive = true;
    }

    const entry = { id, date, kind, monthlyBase, seconds, compensatedSeconds, startedAt, endsAt };
    const total = (secondsByDate.get(date) ?? 0) + reservedSeconds(entry);
    if (total > DAY_SECONDS) throw invalid();
    ids.add(id);
    secondsByDate.set(date, total);
    return entry;
  });
  return { monthlyBase: value.monthlyBase, entries };
}

export function overtimeSeconds(entry: OvertimeEntry, now: number): number {
  if (!live(entry)) return entry.seconds;
  return Math.max(0, Math.floor((Math.min(now, entry.endsAt) - entry.startedAt) / 1000));
}

export function overtimePay(entry: OvertimeEntry, now: number): number {
  const paidSeconds = overtimeSeconds(entry, now) - entry.compensatedSeconds;
  const hourlyRate = entry.monthlyBase / (MONTHLY_PAID_DAYS * STANDARD_DAY_HOURS);
  return (paidSeconds / 3600) * hourlyRate * OVERTIME_MULTIPLIERS[entry.kind];
}

export function getActiveOvertime(data: OvertimeData) {
  return data.entries.find(live);
}

export function closeOvertime(data: OvertimeData, now: number): OvertimeData {
  const active = getActiveOvertime(data);
  if (!active) return data;
  const seconds = overtimeSeconds(active, now);
  const entries = seconds === 0
    ? data.entries.filter(entry => entry.id !== active.id)
    : data.entries.map(entry => entry.id === active.id ? { ...entry, startedAt: null, endsAt: null, seconds } : entry);
  return { ...data, entries };
}

export function reconcileOvertime(data: OvertimeData, now: number): OvertimeData {
  const active = getActiveOvertime(data);
  return active && now >= active.endsAt ? closeOvertime(data, now) : data;
}

export function setOvertimeBase(data: OvertimeData, base: number | null): OvertimeData {
  if (base !== null && !validBase(base)) throw new Error("请输入有效的加班月工资基数。");
  return data.monthlyBase === base ? data : { ...data, monthlyBase: base };
}

function remainingSeconds(data: OvertimeData, date: string, editingId?: string): number {
  return data.entries.reduce((remaining, entry) => (
    entry.date === date && entry.id !== editingId ? remaining - reservedSeconds(entry) : remaining
  ), DAY_SECONDS);
}

function checkEntryLimit(data: OvertimeData) {
  if (data.entries.length >= MAX_ENTRIES) throw new Error("加班记录已达上限，请先删除不需要的条目。");
}

function checkCalculationInput({ kind, monthlyBase }: Pick<OvertimeInput, "kind" | "monthlyBase">) {
  if (!validKind(kind)) throw new Error("请选择加班类型。");
  if (!validBase(monthlyBase)) throw new Error("请输入有效的加班月工资基数。");
}

export function startOvertime(data: OvertimeData, input: Pick<OvertimeInput, "kind" | "monthlyBase">, now: number): OvertimeData {
  if (!validTimestamp(now)) throw new Error("当前时间无效。");
  const date = localDateKey(now);
  if (!validDate(date)) throw new Error("当前日期不在支持范围内。");
  const current = reconcileOvertime(data, now);
  if (getActiveOvertime(current)) throw new Error("请先结束正在计时的加班。");
  checkCalculationInput(input);
  checkEntryLimit(current);

  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 0, 0);
  const endsAt = Math.min(nextMidnight.getTime(), now + remainingSeconds(current, date) * 1000);
  if (endsAt - now < 1000) throw new Error("今天没有可继续记录的加班时间。");
  const entry: OvertimeEntry = {
    id: globalThis.crypto.randomUUID(), date, kind: input.kind, monthlyBase: input.monthlyBase,
    seconds: 0, compensatedSeconds: 0, startedAt: now, endsAt,
  };
  return { ...current, entries: [entry, ...current.entries] };
}

export function saveOvertime(data: OvertimeData, input: OvertimeInput, now: number, id?: string): OvertimeData {
  const { date, kind, monthlyBase, seconds, compensatedSeconds } = input;
  if (!validTimestamp(now)) throw new Error("当前时间无效。");
  if (!validDate(date) || date > localDateKey(now)) throw new Error("请选择今天或更早的日期。");
  checkCalculationInput(input);
  if (!validSeconds(seconds) || seconds === 0) throw new Error("加班时长须大于零，且一天最多记录 24 小时。");
  if (!validSeconds(compensatedSeconds) || compensatedSeconds > seconds || (kind !== "rest" && compensatedSeconds !== 0))
    throw new Error("仅休息日可填补休时长，且补休时长不能超过加班时长。");

  const current = reconcileOvertime(data, now);
  if (id === undefined) checkEntryLimit(current);
  else {
    const previous = current.entries.find(entry => entry.id === id);
    if (!previous) throw new Error("没有找到这笔加班记录。");
    if (live(previous)) throw new Error("请先结束加班计时，再编辑记录。");
  }
  if (seconds > remainingSeconds(current, date, id)) throw new Error("该日的加班时长合计不能超过 24 小时。");
  const entry: OvertimeEntry = {
    id: id ?? globalThis.crypto.randomUUID(), date, kind, monthlyBase, seconds, compensatedSeconds,
    startedAt: null, endsAt: null,
  };
  const entries = id === undefined ? [entry, ...current.entries] : current.entries.map(row => row.id === id ? entry : row);
  return { ...current, entries };
}

export function deleteOvertime(data: OvertimeData, id: string): OvertimeData {
  const entry = data.entries.find(row => row.id === id);
  if (!entry) return data;
  if (live(entry)) throw new Error("请先结束加班计时，再删除记录。");
  return { ...data, entries: data.entries.filter(row => row.id !== id) };
}

export function getOvertimeTotals(data: OvertimeData | undefined, start: string, end: string, now: number) {
  const total = { seconds: 0, earnings: 0 };
  if (!data) return total;
  for (const entry of data.entries) {
    if (entry.date < start || entry.date > end) continue;
    total.seconds += overtimeSeconds(entry, now);
    total.earnings += overtimePay(entry, now);
  }
  return total;
}

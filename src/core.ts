/** Local, deterministic payroll estimates. All timestamps are milliseconds. */
import { getPublicHoliday, getHolidayYears } from "./holidays";
export type ScheduleMode = "double" | "single" | "alternate";
export interface DayHours {
  start: string;
  end: string;
}
export interface PayrollSettings {
  cycleStartDay: number;
  payDay: number;
  /** Month containing the period end, or one/two months after that month. */
  payMonthOffset: 0 | 1 | 2;
  holidayAdjustment: "previous" | "next" | "none";
}
export interface PayrollPeriod {
  start: string;
  end: string;
  workdays: number;
  nominalPayday: string;
  actualPayday: string | null;
  /** Signed calendar days from nominal to adjusted payday; zero if unavailable. */
  adjustmentDays: number;
  holidayCoverageComplete: boolean;
}
export interface Settings {
  monthlySalary: number;
  scheduleMode: ScheduleMode;
  restDay: number;
  doubleRestDays: number[];
  alternateAnchor: string;
  weekdayHours: Record<number, DayHours>;
  lunch: { enabled: boolean; start: string; end: string };
  dinner: { enabled: boolean; start: string; end: string };
  publicHolidays: boolean;
  payroll: PayrollSettings;
  overrides: Record<string, "work" | "rest">;
}
export interface DayPlan {
  working: boolean;
  start: number;
  end: number;
  breakStart: number | null;
  breakEnd: number | null;
  dinnerStart: number | null;
  dinnerEnd: number | null;
  plannedSeconds: number;
  workdays: number;
  dailyWage: number;
  perSecond: number;
  periodStart: string;
  periodEnd: string;
}
export interface WorkInterval {
  from: number;
  to: number | null;
}
export interface DayRecord {
  date: string;
  plan: DayPlan;
  intervals: WorkInterval[];
  completed: boolean;
}
export interface AppData {
  version: 1;
  settings: Settings;
  records: Record<string, DayRecord>;
}
export type WorkStatus = "idle" | "working" | "paused" | "completed" | "rest";
export interface DaySummary {
  date: string;
  status: WorkStatus;
  seconds: number;
  earnings: number;
  plannedSeconds: number;
  dailyWage: number;
  perSecond: number;
  progress: number;
  remainingSeconds: number;
  plan: DayPlan;
}

const DAY_MS = 86_400_000;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const validTime = (value: unknown): value is string =>
  typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const pad = (number: number) => String(number).padStart(2, "0");

function validMonthDay(value: unknown): value is number {
  return finite(value) && Number.isInteger(value) && value >= 1 && value <= 31;
}

function validWeekday(value: unknown): value is number {
  return finite(value) && Number.isInteger(value) && value >= 0 && value <= 6;
}

function validDoubleRestDays(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === 2 &&
    validWeekday(value[0]) && validWeekday(value[1]) && value[0] !== value[1];
}

export function dateKey(value: Date | number = Date.now()): string {
  const date = value instanceof Date ? value : new Date(value);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localDate(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function validDateKey(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^(?:19|20|21|22)\d\d-\d\d-\d\d$/.test(value)
  )
    return false;
  return dateKey(localDate(value)) === value;
}

function atTime(key: string, time: string): number {
  const date = localDate(key);
  const [hour, minute] = time.split(":").map(Number);
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

function calendarOrdinal(key: string): number {
  const date = localDate(key);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

function mondayOrdinal(key: string): number {
  const date = localDate(key);
  return calendarOrdinal(key) - ((date.getDay() + 6) % 7);
}

export function defaultSettings(): Settings {
  const monday = new Date();
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return {
    monthlySalary: 15000,
    scheduleMode: "double",
    restDay: 0,
    doubleRestDays: [6, 0],
    alternateAnchor: dateKey(monday),
    weekdayHours: Object.fromEntries(
      Array.from({ length: 7 }, (_, weekday) => [
        weekday,
        { start: "09:00", end: "18:00" },
      ]),
    ),
    lunch: { enabled: true, start: "12:00", end: "13:00" },
    dinner: { enabled: true, start: "18:00", end: "19:00" },
    publicHolidays: true,
    payroll: {
      cycleStartDay: 1,
      payDay: 15,
      payMonthOffset: 1,
      holidayAdjustment: "previous",
    },
    overrides: {},
  };
}

export function emptyData(): AppData {
  return { version: 1, settings: defaultSettings(), records: {} };
}

export function normalizeSettings(value: unknown): Settings {
  const settings = defaultSettings();
  if (!isObject(value)) return settings;
  if (
    finite(value.monthlySalary) &&
    value.monthlySalary >= 0 &&
    value.monthlySalary <= 1e9
  )
    settings.monthlySalary = value.monthlySalary;
  if (
    value.scheduleMode === "double" ||
    value.scheduleMode === "single" ||
    value.scheduleMode === "alternate"
  )
    settings.scheduleMode = value.scheduleMode;
  if (
    finite(value.restDay) &&
    Number.isInteger(value.restDay) &&
    value.restDay >= 0 &&
    value.restDay <= 6
  )
    settings.restDay = value.restDay;
  if (validDoubleRestDays(value.doubleRestDays))
    settings.doubleRestDays = [...value.doubleRestDays].sort((a, b) =>
      ((a + 6) % 7) - ((b + 6) % 7));
  if (validDateKey(value.alternateAnchor)) {
    const anchor = localDate(value.alternateAnchor);
    anchor.setDate(anchor.getDate() - ((anchor.getDay() + 6) % 7));
    settings.alternateAnchor = dateKey(anchor);
  }
  if (isObject(value.weekdayHours)) {
    for (let weekday = 0; weekday < 7; weekday++) {
      const hours = value.weekdayHours[weekday];
      if (
        isObject(hours) &&
        validTime(hours.start) &&
        validTime(hours.end) &&
        hours.start < hours.end
      ) {
        settings.weekdayHours[weekday] = { start: hours.start, end: hours.end };
      }
    }
  }
  for (const kind of ["lunch", "dinner"] as const) {
    const valueBreak = value[kind];
    if (!isObject(valueBreak)) continue;
    if (typeof valueBreak.enabled === "boolean")
      settings[kind].enabled = valueBreak.enabled;
    if (
      validTime(valueBreak.start) &&
      validTime(valueBreak.end) &&
      valueBreak.start < valueBreak.end
    ) {
      settings[kind].start = valueBreak.start;
      settings[kind].end = valueBreak.end;
    }
  }
  if (typeof value.publicHolidays === "boolean")
    settings.publicHolidays = value.publicHolidays;
  if (isObject(value.payroll)) {
    const payroll = value.payroll;
    if (validMonthDay(payroll.cycleStartDay))
      settings.payroll.cycleStartDay = payroll.cycleStartDay;
    if (validMonthDay(payroll.payDay)) settings.payroll.payDay = payroll.payDay;
    if (
      payroll.payMonthOffset === 0 ||
      payroll.payMonthOffset === 1 ||
      payroll.payMonthOffset === 2
    )
      settings.payroll.payMonthOffset = payroll.payMonthOffset;
    if (
      payroll.holidayAdjustment === "previous" ||
      payroll.holidayAdjustment === "next" ||
      payroll.holidayAdjustment === "none"
    )
      settings.payroll.holidayAdjustment = payroll.holidayAdjustment;
  }
  if (isObject(value.overrides)) {
    for (const [key, kind] of Object.entries(value.overrides)) {
      if (validDateKey(key) && (kind === "work" || kind === "rest"))
        settings.overrides[key] = kind;
    }
  }
  return settings;
}

export function validateSettings(settings: Settings): string[] {
  const errors: string[] = [];
  if (
    !finite(settings.monthlySalary) ||
    settings.monthlySalary < 0 ||
    settings.monthlySalary > 1e9
  )
    errors.push("请输入有效的税前月薪（0 至 10 亿元）");
  if (!["double", "single", "alternate"].includes(settings.scheduleMode))
    errors.push("请选择工作制");
  if (!settings.payroll || !validMonthDay(settings.payroll.cycleStartDay))
    errors.push("计薪周期起始日请选择 1 至 31 日");
  if (!settings.payroll || !validMonthDay(settings.payroll.payDay))
    errors.push("发薪日请选择 1 至 31 日");
  if (!settings.payroll || ![0, 1, 2].includes(settings.payroll.payMonthOffset))
    errors.push("请选择有效的发薪月份");
  if (
    !settings.payroll ||
    !["previous", "next", "none"].includes(settings.payroll.holidayAdjustment)
  )
    errors.push("请选择发薪日遇休息日时的调整方式");
  if (
    !Number.isInteger(settings.restDay) ||
    settings.restDay < 0 ||
    settings.restDay > 6
  )
    errors.push("请选择有效的休息日");
  if (settings.scheduleMode !== "single" && !validDoubleRestDays(settings.doubleRestDays))
    errors.push("双休周请选择两个不同的休息日");
  if (!validDateKey(settings.alternateAnchor))
    errors.push("请选择有效的大小周基准日期");
  else if (
    settings.scheduleMode === "alternate" &&
    localDate(settings.alternateAnchor).getDay() !== 1
  )
    errors.push("大小周基准日期请选择双休周的周一");
  for (let weekday = 0; weekday < 7; weekday++) {
    const hours = settings.weekdayHours?.[weekday];
    if (
      !hours ||
      !validTime(hours.start) ||
      !validTime(hours.end) ||
      hours.start >= hours.end
    )
      errors.push(
        `周${["日", "一", "二", "三", "四", "五", "六"][weekday]}的下班时间必须晚于上班时间`,
      );
    else {
      const start = minutes(hours.start),
        end = minutes(hours.end);
      const breaks = [settings.lunch, settings.dinner].filter(
        (value) =>
          value?.enabled &&
          validTime(value.start) &&
          validTime(value.end) &&
          value.start < value.end,
      );
      const excluded = mergedRanges(
        breaks.map((value) => [
          Math.max(start, minutes(value.start)),
          Math.min(end, minutes(value.end)),
        ]),
      );
      if (end - start - rangesLength(excluded) <= 0)
        errors.push(
          `周${["日", "一", "二", "三", "四", "五", "六"][weekday]}的计薪时长不能为零`,
        );
    }
  }
  for (const [kind, label] of [
    ["lunch", "午休"],
    ["dinner", "晚饭"],
  ] as const) {
    const value = settings[kind];
    if (
      !value ||
      typeof value.enabled !== "boolean" ||
      (value.enabled &&
        (!validTime(value.start) ||
          !validTime(value.end) ||
          value.start >= value.end))
    )
      errors.push(`${label}结束时间必须晚于开始时间`);
  }
  return [...new Set(errors)];
}

function minutes(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

/** Clip a configured/saved break to the working day, ignoring missing legacy values. */
function clippedBreak(
  start: number,
  end: number,
  breakStart: unknown,
  breakEnd: unknown,
): [number | null, number | null] {
  if (!finite(breakStart) || !finite(breakEnd)) return [null, null];
  const from = Math.max(start, breakStart),
    to = Math.min(end, breakEnd);
  return to > from ? [from, to] : [null, null];
}

/** Merging also handles adjacent breaks; overlapping meals can only be deducted once. */
function mergedRanges(ranges: (number | null | undefined)[][]): number[][] {
  const sorted = ranges
    .filter(
      (range): range is number[] =>
        finite(range[0]) && finite(range[1]) && range[1] > range[0],
    )
    .map(([from, to]) => [from, to])
    .sort((a, b) => a[0] - b[0]);
  const merged: number[][] = [];
  for (const [from, to] of sorted) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

function rangesLength(ranges: number[][]): number {
  return ranges.reduce((total, [start, end]) => total + end - start, 0);
}

export function isWorkday(key: string, settings: Settings): boolean {
  if (!validDateKey(key)) return false;
  const override = settings.overrides[key];
  if (override) return override === "work";
  const holiday = settings.publicHolidays ? getPublicHoliday(key) : null;
  if (holiday) return holiday.kind === "work";
  return !isWeeklyRestDay(key, settings);
}

/** The weekly rule alone, before official holidays and per-date overrides. */
export function isWeeklyRestDay(key: string, settings: Settings): boolean {
  if (!validDateKey(key)) return false;
  const weekday = localDate(key).getDay();
  const doubleRestDays = validDoubleRestDays(settings.doubleRestDays)
    ? settings.doubleRestDays : [6, 0];
  if (settings.scheduleMode === "double") return doubleRestDays.includes(weekday);
  if (settings.scheduleMode === "single") return weekday === settings.restDay;
  const weekOffset = Math.round(
    (mondayOrdinal(key) - mondayOrdinal(settings.alternateAnchor)) / 7,
  );
  const isDoubleWeek = ((weekOffset % 2) + 2) % 2 === 0;
  return isDoubleWeek
    ? doubleRestDays.includes(weekday)
    : weekday === settings.restDay;
}

export function monthDays(
  year: number,
  month: number,
  settings: Settings,
): { date: string; working: boolean }[] {
  if (
    !Number.isInteger(year) ||
    year < 1900 ||
    year > 2299 ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12
  )
    return [];
  const count = new Date(year, month, 0).getDate();
  return Array.from({ length: count }, (_, index) => {
    const key = dateKey(new Date(year, month - 1, index + 1));
    return { date: key, working: isWorkday(key, settings) };
  });
}

export function countWorkdays(
  year: number,
  month: number,
  settings: Settings,
): number {
  return monthDays(year, month, settings).filter((day) => day.working).length;
}

/** Calendar-only math avoids DST changing a payroll date or countdown. */
function addCalendarDays(key: string, days: number): string {
  return new Date((calendarOrdinal(key) + days) * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function clampedMonthDay(year: number, month: number, day: number): string {
  const first = new Date(year, month - 1, 1);
  const lastDay = new Date(
    first.getFullYear(),
    first.getMonth() + 1,
    0,
  ).getDate();
  return dateKey(
    new Date(first.getFullYear(), first.getMonth(), Math.min(day, lastDay)),
  );
}

function periodBoundsForMonth(
  year: number,
  month: number,
  cycleStartDay: number,
): { start: string; end: string } {
  const start = clampedMonthDay(year, month, cycleStartDay);
  const nextStart = clampedMonthDay(year, month + 1, cycleStartDay);
  return { start, end: addCalendarDays(nextStart, -1) };
}

function coveredHolidayYears(
  start: string,
  end: string,
  settings: Settings,
): boolean {
  if (!settings.publicHolidays) return true;
  const firstYear = Number(start.slice(0, 4)),
    lastYear = Number(end.slice(0, 4));
  const [firstDate, lastDate] = start <= end ? [start, end] : [end, start];
  const available = getHolidayYears();
  for (
    let year = Math.min(firstYear, lastYear);
    year <= Math.max(firstYear, lastYear);
    year++
  ) {
    if (!available.includes(year)) return false;
    // The following year's New Year notice can change this December's days.
    if (firstDate <= `${year}-12-31` && lastDate >= `${year}-12-01` &&
      !available.includes(year + 1)) return false;
  }
  return true;
}

function payrollPeriodForMonth(
  year: number,
  month: number,
  settings: Settings,
): PayrollPeriod {
  const { start, end } = periodBoundsForMonth(
    year,
    month,
    settings.payroll.cycleStartDay,
  );
  let workdays = 0;
  for (let key = start; key <= end; key = addCalendarDays(key, 1)) {
    if (isWorkday(key, settings)) workdays++;
  }
  const last = localDate(end);
  const nominalPayday = clampedMonthDay(
    last.getFullYear(),
    last.getMonth() + 1 + settings.payroll.payMonthOffset,
    settings.payroll.payDay,
  );
  const direction = settings.payroll.holidayAdjustment === "previous" ? -1 : 1;
  let actualPayday: string | null = settings.payroll.holidayAdjustment === "none"
    ? nominalPayday : null;
  let lastSearched = nominalPayday;
  // The nominal date itself is accepted when working; otherwise search only in the selected direction.
  for (let distance = 0; actualPayday === null && distance <= 366; distance++) {
    const candidate = addCalendarDays(nominalPayday, distance * direction);
    lastSearched = candidate;
    if (!validDateKey(candidate)) break;
    if (isWorkday(candidate, settings)) {
      actualPayday = candidate;
      break;
    }
  }
  return {
    start,
    end,
    workdays,
    nominalPayday,
    actualPayday,
    adjustmentDays: actualPayday
      ? calendarOrdinal(actualPayday) - calendarOrdinal(nominalPayday)
      : 0,
    holidayCoverageComplete:
      coveredHolidayYears(start, end, settings) &&
      (settings.payroll.holidayAdjustment === "none" ||
        coveredHolidayYears(nominalPayday, lastSearched, settings)),
  };
}

/** Inclusive monthly period containing a local date. Short months clamp each month's anchor independently. */
export function getPayrollPeriod(
  key: string,
  settings: Settings,
): PayrollPeriod {
  if (!validDateKey(key)) throw new RangeError("计薪周期日期无效");
  const date = localDate(key);
  const anchor = clampedMonthDay(
    date.getFullYear(),
    date.getMonth() + 1,
    settings.payroll.cycleStartDay,
  );
  return payrollPeriodForMonth(
    date.getFullYear(),
    date.getMonth() + 1 - (key < anchor ? 1 : 0),
    settings,
  );
}

/** Navigate by the original anchor month rather than adding months to a clamped day. */
export function shiftPayrollPeriod(
  period: Pick<PayrollPeriod, "start">,
  delta: number,
  settings: Settings,
): PayrollPeriod {
  if (!validDateKey(period.start) || !Number.isInteger(delta))
    throw new RangeError("计薪周期切换参数无效");
  const date = localDate(period.start);
  return payrollPeriodForMonth(
    date.getFullYear(),
    date.getMonth() + 1 + delta,
    settings,
  );
}

/** Next scheduled payday, including today and payouts belonging to older earning periods. */
export function getNextPayday(
  key: string,
  settings: Settings,
): (PayrollPeriod & { daysUntil: number }) | null {
  if (!validDateKey(key)) throw new RangeError("发薪日期无效");
  const date = localDate(key);
  const candidates: PayrollPeriod[] = [];
  // A closure can delay an old payout by 366 days. Search backwards as well as forwards.
  for (let offset = -16; offset <= 16; offset++) {
    const period = payrollPeriodForMonth(
      date.getFullYear(),
      date.getMonth() + 1 + offset,
      settings,
    );
    if (period.actualPayday && period.actualPayday >= key)
      candidates.push(period);
  }
  candidates.sort(
    (a, b) =>
      a.actualPayday!.localeCompare(b.actualPayday!) ||
      a.start.localeCompare(b.start),
  );
  const next = candidates[0];
  return next
    ? {
        ...next,
        daysUntil: calendarOrdinal(next.actualPayday!) - calendarOrdinal(key),
      }
    : null;
}

export function getDayPlan(key: string, settings: Settings): DayPlan {
  const date = localDate(key);
  const hours = settings.weekdayHours[date.getDay()];
  const start = atTime(key, hours.start);
  const end = atTime(key, hours.end);
  const working = isWorkday(key, settings);
  const [breakStart, breakEnd] = clippedBreak(
    start,
    end,
    settings.lunch.enabled ? atTime(key, settings.lunch.start) : null,
    settings.lunch.enabled ? atTime(key, settings.lunch.end) : null,
  );
  const [dinnerStart, dinnerEnd] = clippedBreak(
    start,
    end,
    settings.dinner.enabled ? atTime(key, settings.dinner.start) : null,
    settings.dinner.enabled ? atTime(key, settings.dinner.end) : null,
  );
  const breakMilliseconds = rangesLength(
    mergedRanges([
      [breakStart, breakEnd],
      [dinnerStart, dinnerEnd],
    ]),
  );
  const plannedSeconds = working
    ? Math.max(0, (end - start - breakMilliseconds) / 1000)
    : 0;
  const period = getPayrollPeriod(key, settings);
  const workdays = period.workdays;
  const dailyWage =
    working && plannedSeconds > 0 && workdays > 0
      ? settings.monthlySalary / workdays
      : 0;
  return {
    working,
    start,
    end,
    breakStart,
    breakEnd,
    dinnerStart,
    dinnerEnd,
    plannedSeconds,
    workdays,
    dailyWage,
    perSecond: plannedSeconds > 0 ? dailyWage / plannedSeconds : 0,
    periodStart: period.start,
    periodEnd: period.end,
  };
}

/** Sanitize persisted/IPC data; never trust objects coming from storage or a renderer. */
export function normalizeData(value: unknown): AppData {
  if (!isObject(value) || value.version !== 1) return emptyData();
  const data: AppData = {
    version: 1,
    settings: normalizeSettings(value.settings),
    records: {},
  };
  if (!isObject(value.records)) return data;
  for (const [key, raw] of Object.entries(value.records).slice(-10000)) {
    if (
      !validDateKey(key) ||
      !isObject(raw) ||
      !isObject(raw.plan) ||
      !Array.isArray(raw.intervals)
    )
      continue;
    const source = raw.plan;
    const dayStart = localDate(key).getTime();
    const nextDate = localDate(key);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextDay = nextDate.getTime();
    if (
      !finite(source.start) ||
      !finite(source.end) ||
      source.start < dayStart ||
      source.end >= nextDay ||
      source.end <= source.start
    )
      continue;
    if (
      !finite(source.dailyWage) ||
      source.dailyWage < 0 ||
      source.dailyWage > 1e9 ||
      !finite(source.workdays) ||
      !Number.isInteger(source.workdays) ||
      source.workdays < 1 ||
      source.workdays > 31
    )
      continue;
    const [breakStart, breakEnd] = clippedBreak(
      source.start,
      source.end,
      source.breakStart,
      source.breakEnd,
    );
    // Old snapshots have no dinner fields: never introduce a new break into their earned history.
    const [dinnerStart, dinnerEnd] = clippedBreak(
      source.start,
      source.end,
      source.dinnerStart,
      source.dinnerEnd,
    );
    const excluded = mergedRanges([
      [breakStart, breakEnd],
      [dinnerStart, dinnerEnd],
    ]);
    const plannedSeconds =
      (source.end - source.start - rangesLength(excluded)) / 1000;
    if (plannedSeconds <= 0) continue;
    const plan: DayPlan = {
      working: true,
      start: source.start,
      end: source.end,
      breakStart,
      breakEnd,
      dinnerStart,
      dinnerEnd,
      plannedSeconds,
      workdays: source.workdays,
      dailyWage: source.dailyWage,
      perSecond: source.dailyWage / plannedSeconds,
      // Before payroll-cycle support, records always belonged to their calendar month.
      periodStart:
        validDateKey(source.periodStart) &&
        validDateKey(source.periodEnd) &&
        source.periodStart <= key &&
        source.periodEnd >= key &&
        calendarOrdinal(source.periodEnd) -
          calendarOrdinal(source.periodStart) <
          31
          ? source.periodStart
          : clampedMonthDay(
              localDate(key).getFullYear(),
              localDate(key).getMonth() + 1,
              1,
            ),
      periodEnd:
        validDateKey(source.periodStart) &&
        validDateKey(source.periodEnd) &&
        source.periodStart <= key &&
        source.periodEnd >= key &&
        calendarOrdinal(source.periodEnd) -
          calendarOrdinal(source.periodStart) <
          31
          ? source.periodEnd
          : clampedMonthDay(
              localDate(key).getFullYear(),
              localDate(key).getMonth() + 1,
              31,
            ),
    };
    const intervals: WorkInterval[] = [];
    let hasOpen = false;
    for (const interval of raw.intervals.slice(0, 10000)) {
      if (!isObject(interval) || !finite(interval.from)) continue;
      const from = Math.min(plan.end, Math.max(plan.start, interval.from));
      if (interval.to === null && !hasOpen && raw.completed !== true) {
        intervals.push({ from, to: null });
        hasOpen = true;
      } else if (finite(interval.to))
        intervals.push({
          from,
          to: Math.min(plan.end, Math.max(from, interval.to)),
        });
    }
    data.records[key] = {
      date: key,
      plan,
      intervals,
      completed: raw.completed === true,
    };
  }
  return data;
}

function elapsedSeconds(record: DayRecord, now: number): number {
  const { plan } = record;
  // A closed interval is an earned fact. A later system-clock correction must not erase it.
  const ranges = record.intervals
    .map((interval) => [
      Math.max(plan.start, interval.from),
      Math.min(plan.end, interval.to ?? now),
    ])
    .filter(([from, to]) => to > from)
    .sort((a, b) => a[0] - b[0]);
  const merged = mergedRanges(ranges);
  const excluded = mergedRanges([
    [plan.breakStart, plan.breakEnd],
    [plan.dinnerStart, plan.dinnerEnd],
  ]);
  let milliseconds = 0;
  for (const [from, to] of merged) {
    const unpaid = excluded.reduce(
      (total, [start, end]) =>
        total + Math.max(0, Math.min(to, end) - Math.max(from, start)),
      0,
    );
    milliseconds += to - from - unpaid;
  }
  return Math.min(
    plan.plannedSeconds,
    Math.max(0, Math.floor(milliseconds / 1000)),
  );
}

export function getDaySummary(data: AppData, now = Date.now()): DaySummary {
  const key = dateKey(now);
  const record = data.records[key];
  const plan = record?.plan ?? getDayPlan(key, data.settings);
  const seconds = record ? elapsedSeconds(record, now) : 0;
  const status: WorkStatus = !plan.working
    ? "rest"
    : record?.completed || now >= plan.end
      ? "completed"
      : record?.intervals.some((interval) => interval.to === null)
        ? "working"
        : record
          ? "paused"
          : "idle";
  return {
    date: key,
    status,
    seconds,
    earnings: Math.min(plan.dailyWage, seconds * plan.perSecond),
    plannedSeconds: plan.plannedSeconds,
    dailyWage: plan.dailyWage,
    perSecond: plan.perSecond,
    progress:
      plan.plannedSeconds > 0 ? Math.min(1, seconds / plan.plannedSeconds) : 0,
    remainingSeconds: Math.max(0, plan.plannedSeconds - seconds),
    plan,
  };
}

/** Close old sessions at their scheduled end. Reopening the app never starts a new day. */
export function reconcileData(data: AppData, now = Date.now()): AppData {
  let records = data.records;
  for (const [key, record] of Object.entries(data.records)) {
    if (now < record.plan.end || record.completed) continue;
    if (records === data.records) records = { ...records };
    records[key] = {
      ...record,
      completed: true,
      intervals: record.intervals.map((interval) =>
        interval.to === null
          ? { ...interval, to: Math.max(interval.from, record.plan.end) }
          : interval,
      ),
    };
  }
  return records === data.records ? data : { ...data, records };
}

export function startWork(data: AppData, now = Date.now()): AppData {
  const current = reconcileData(data, now);
  const key = dateKey(now);
  const existing = current.records[key];
  const plan = existing?.plan ?? getDayPlan(key, current.settings);
  if (
    !plan.working ||
    plan.plannedSeconds <= 0 ||
    now >= plan.end ||
    existing?.completed ||
    existing?.intervals.some((interval) => interval.to === null)
  )
    return current;
  const record: DayRecord = existing ?? {
    date: key,
    plan,
    intervals: [],
    completed: false,
  };
  return {
    ...current,
    records: {
      ...current.records,
      [key]: {
        ...record,
        intervals: [
          ...record.intervals,
          { from: Math.max(now, plan.start), to: null },
        ],
      },
    },
  };
}

function closeToday(data: AppData, now: number, completed: boolean): AppData {
  const current = reconcileData(data, now);
  const key = dateKey(now);
  const record = current.records[key];
  if (!record || record.completed) return current;
  const hasOpen = record.intervals.some((interval) => interval.to === null);
  if (!completed && !hasOpen) return current;
  return {
    ...current,
    records: {
      ...current.records,
      [key]: {
        ...record,
        completed,
        intervals: record.intervals.map((interval) =>
          interval.to === null
            ? {
                ...interval,
                to: Math.min(record.plan.end, Math.max(interval.from, now)),
              }
            : interval,
        ),
      },
    },
  };
}

export function pauseWork(data: AppData, now = Date.now()): AppData {
  return closeToday(data, now, false);
}
export function finishWork(data: AppData, now = Date.now()): AppData {
  return closeToday(data, now, true);
}

export function monthEarnings(
  data: AppData,
  year: number,
  month: number,
  now = Date.now(),
): number {
  const prefix = `${year}-${pad(month)}-`;
  return Object.entries(data.records)
    .filter(([key]) => key.startsWith(prefix))
    .reduce(
      (total, [, record]) =>
        total +
        Math.min(
          record.plan.dailyWage,
          elapsedSeconds(record, now) * record.plan.perSecond,
        ),
      0,
    );
}

/** Sum actual recorded earnings in an inclusive date range without repricing historical records. */
export function periodEarnings(
  data: AppData,
  start: string,
  end: string,
  now = Date.now(),
): number {
  if (!validDateKey(start) || !validDateKey(end) || start > end) return 0;
  return Object.entries(data.records)
    .filter(([key]) => key >= start && key <= end)
    .reduce(
      (total, [, record]) =>
        total +
        Math.min(
          record.plan.dailyWage,
          elapsedSeconds(record, now) * record.plan.perSecond,
        ),
      0,
    );
}

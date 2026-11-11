import type { HolidayYearData } from "./holiday-types";

export interface PublicHoliday {
  kind: "rest" | "work";
  name: string;
}

export interface PublicHolidayCountdown {
  date: string;
  name: string;
  daysUntil: number;
  ongoing: boolean;
  coverageComplete: boolean;
}

// Runtime data comes only from the downloaded/cache snapshot installed by the
// holiday service. A new installation has no assumed or bundled holiday dates.
let calendar = new Map<string, Readonly<PublicHoliday>>();
let availableYears: number[] = [];

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validYear(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1900 && value <= 2299;
}

function httpsUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

function validDate(value: unknown, year: number): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) return false;
  const dateYear = Number(value.slice(0, 4));
  return dateYear === year || (dateYear === year - 1 && value.slice(5, 7) === "12");
}

/** Validate a holiday-cn response before it can affect payroll or disk caches. */
export function parseHolidayYear(
  raw: unknown,
  expectedYear: number,
  fetchedAt: number,
  source: string,
): HolidayYearData {
  if (!validYear(expectedYear) || !isObject(raw) || raw.year !== expectedYear)
    throw new Error("节假日数据年份不正确。");
  if (!Number.isFinite(fetchedAt) || fetchedAt < 0 || fetchedAt > 8.64e15 || !httpsUrl(source))
    throw new Error("节假日数据来源或获取时间不正确。");
  if (!Array.isArray(raw.papers) || !Array.isArray(raw.days))
    throw new Error("节假日数据格式不正确。");
  if (!raw.papers.length || !raw.days.length)
    throw new Error("该年度节假日安排尚未公布。");
  if (raw.papers.length > 32 || raw.days.length > 400)
    throw new Error("节假日数据条目过多。");
  const papers = raw.papers.map((value) => {
    const url = httpsUrl(value);
    if (!url || !(url.hostname === "gov.cn" || url.hostname.endsWith(".gov.cn")))
      throw new Error("节假日数据缺少有效的官方公告来源。");
    return value as string;
  });
  const seen = new Set<string>();
  const days = raw.days.map((day) => {
    if (!isObject(day) || !validDate(day.date, expectedYear) ||
      typeof day.name !== "string" || !day.name.trim() || day.name.length > 160 ||
      /[\u0000-\u001f\u007f]/.test(day.name) || typeof day.isOffDay !== "boolean")
      throw new Error("节假日日期、名称或休息标记不正确。");
    if (seen.has(day.date)) throw new Error("节假日数据包含重复日期。");
    seen.add(day.date);
    return { date: day.date, name: day.name.trim(), isOffDay: day.isOffDay };
  }).sort((a, b) => a.date.localeCompare(b.date));
  return { year: expectedYear, papers: [...new Set(papers)], days, fetchedAt, source };
}

/** Atomically replace runtime data; failed validation leaves the old data intact. */
export function installHolidayData(years: readonly HolidayYearData[]): void {
  if (!Array.isArray(years) || years.length > 400)
    throw new Error("节假日年度缓存不正确。");
  const seen = new Set<number>();
  const validated = years.map((year) => {
    if (!isObject(year) || seen.has(year.year as number))
      throw new Error("节假日年度缓存重复或无效。");
    const value = parseHolidayYear(year, year.year as number, year.fetchedAt as number, year.source as string);
    seen.add(value.year);
    return value;
  }).sort((a, b) => a.year - b.year);
  const next = new Map<string, Readonly<PublicHoliday>>();
  for (const year of validated) {
    for (const day of year.days) {
      // A newer annual notice may alter the previous December's schedule.
      const name = day.isOffDay || day.name.includes("补班") ? day.name : `${day.name}补班`;
      next.set(day.date, Object.freeze({ kind: day.isOffDay ? "rest" : "work", name }));
    }
  }
  calendar = next;
  availableYears = validated.map((year) => year.year);
}

/** Only downloaded, validated years count as holiday coverage. */
export function getHolidayYears(): number[] {
  return [...availableYears];
}

/** A published exception, or null for ordinary dates or missing data. */
export function getPublicHoliday(dateKey: string): PublicHoliday | null {
  const day = calendar.get(dateKey);
  return day ? { ...day } : null;
}

/** Next announced public holiday, including an ongoing holiday today. */
export function getNextPublicHoliday(dateKey: string): PublicHolidayCountdown | null {
  if (typeof dateKey !== "string") return null;
  const firstYear = Number(dateKey.slice(0, 4));
  if (!validYear(firstYear) || !validDate(dateKey, firstYear)) return null;

  let candidate: { date: string; name: string } | null = null;
  for (const [date, day] of calendar) {
    // Ordinary weekends and compensatory workdays are not public holidays.
    // Returning today while a holiday is in progress avoids counting each
    // subsequent day of the same vacation as a new upcoming holiday.
    if (day.kind === "rest" && date >= dateKey && (!candidate || date < candidate.date))
      candidate = { date, name: day.name };
  }
  if (!candidate) return null;

  const available = new Set(availableYears);
  const lastYear = Number(candidate.date.slice(0, 4));
  let coverageComplete = true;
  for (let year = firstYear; year <= lastYear; year++) {
    // An unobserved intervening year may contain an earlier holiday; the next
    // year's announcement can also change the preceding December's schedule.
    if (!available.has(year) ||
      (dateKey <= `${year}-12-31` && candidate.date >= `${year}-12-01` && !available.has(year + 1))) {
      coverageComplete = false;
      break;
    }
  }
  return {
    ...candidate,
    daysUntil: (Date.parse(`${candidate.date}T00:00:00Z`) - Date.parse(`${dateKey}T00:00:00Z`)) / 86_400_000,
    ongoing: candidate.date === dateKey,
    coverageComplete,
  };
}

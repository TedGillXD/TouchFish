import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fixture from "../tests/fixtures/china-holidays.json";
import {
  getHolidayYears,
  getPublicHoliday,
  installHolidayData,
  parseHolidayYear,
} from "./holidays";
import { emptyData, getDayPlan, getDaySummary, getPayrollPeriod, isWorkday, normalizeData, startWork } from "./core";
import type { HolidayYearData } from "./holiday-types";

beforeEach(() => installHolidayData([]));
const fetchedAt = Date.parse("2026-11-11T00:00:00Z");
const source = "https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/2026.json";
const yearData = () => structuredClone(fixture[0]);
const localTime = (key: string, hhmm: string) => new Date(`${key}T${hhmm}:00`).getTime();

function listedDays(year: number, kind: "rest" | "work"): string[] {
  const result: string[] = [];
  const end = Date.UTC(year + 1, 0, 1);
  for (let value = Date.UTC(year, 0, 1); value < end; value += 86_400_000) {
    const key = new Date(value).toISOString().slice(0, 10);
    if (getPublicHoliday(key)?.kind === kind) result.push(key);
  }
  return result;
}

test("an empty runtime has no bundled dates or implied official coverage", () => {
  assert.deepEqual(getHolidayYears(), []);
  assert.equal(getPublicHoliday("2026-10-01"), null);
  const { settings } = emptyData();
  assert.equal(getPayrollPeriod("2026-11-10", settings).holidayCoverageComplete, false);
  assert.equal(isWorkday("2026-10-01", settings), true, "missing data follows the configured weekly schedule");
  settings.overrides["2026-10-01"] = "rest";
  assert.equal(isWorkday("2026-10-01", settings), false);
  settings.publicHolidays = false;
  assert.equal(getPayrollPeriod("2026-11-10", settings).holidayCoverageComplete, true);
});

test("downloaded annual data restores vacation and makeup exceptions", () => {
  const parsed = parseHolidayYear(yearData(), 2026, fetchedAt, source);
  installHolidayData([parsed]);
  assert.deepEqual(getHolidayYears(), [2026]);
  assert.equal(listedDays(2026, "rest").length, 33);
  assert.deepEqual(listedDays(2026, "work"), [
    "2026-01-04", "2026-02-14", "2026-02-28", "2026-05-09", "2026-09-20", "2026-10-10",
  ]);
  assert.deepEqual(getPublicHoliday("2026-10-01"), { kind: "rest", name: "国庆节" });
  assert.deepEqual(getPublicHoliday("2026-10-10"), { kind: "work", name: "国庆节补班" });
  assert.equal(getPublicHoliday("2026-10-08"), null);
  assert.equal(getPublicHoliday("2027-01-01"), null);
  installHolidayData(fixture);
  assert.equal(listedDays(2027, "rest").length, 29);
  assert.deepEqual(listedDays(2027, "work"), ["2027-01-31", "2027-02-14", "2027-05-08", "2027-09-26", "2027-10-09"]);
});

test("validation rejects unpublished placeholders, malformed dates and inconsistent schemas", () => {
  const invalid: unknown[] = [
    null, [], {}, { ...yearData(), year: 2027 },
    { ...yearData(), papers: [] }, { ...yearData(), days: [] },
    { ...yearData(), papers: ["https://example.com/not-an-official-notice"] },
    { ...yearData(), papers: ["http://www.gov.cn/notice"] },
    { ...yearData(), papers: ["https://www.gov.cn.evil.example/notice"] },
    { ...yearData(), papers: ["https://secret@www.gov.cn/notice"] },
    { ...yearData(), days: [{ date: "2026-02-30", name: "错误", isOffDay: true }] },
    { ...yearData(), days: [{ date: "2026-1-01", name: "错误", isOffDay: true }] },
    { ...yearData(), days: [{ date: "2025-11-30", name: "错误", isOffDay: true }] },
    { ...yearData(), days: [{ date: "2027-01-01", name: "错误", isOffDay: true }] },
    { ...yearData(), days: [{ date: "2026-01-01", name: "", isOffDay: true }] },
    { ...yearData(), days: [{ date: "2026-01-01", name: "换\n行", isOffDay: true }] },
    { ...yearData(), days: [{ date: "2026-01-01", name: "错误", isOffDay: "true" }] },
    { ...yearData(), days: [yearData().days[0], yearData().days[0]] },
  ];
  for (const value of invalid) assert.throws(() => parseHolidayYear(value, 2026, fetchedAt, source));
  for (const year of [1899, 2300, 2026.5, NaN]) assert.throws(() => parseHolidayYear(yearData(), year, fetchedAt, source));
  for (const time of [-1, NaN, Infinity]) assert.throws(() => parseHolidayYear(yearData(), 2026, time, source));
  for (const url of ["http://raw.githubusercontent.com/data", "file:///cache.json", "https://user:secret@example.com/data", "invalid"])
    assert.throws(() => parseHolidayYear(yearData(), 2026, fetchedAt, url));
  assert.throws(() => parseHolidayYear({ ...yearData(), papers: [] }, 2026, fetchedAt, source), /尚未公布/);
});

test("a newer annual notice can override only the previous December across a year boundary", () => {
  const old = yearData();
  old.days.push({ date: "2026-12-31", name: "旧安排", isOffDay: false });
  const newer = structuredClone(fixture[1]);
  newer.days.push({ date: "2026-12-31", name: "元旦", isOffDay: true });
  const { settings } = emptyData();
  settings.payroll.payMonthOffset = 0;
  installHolidayData([old]);
  assert.equal(getPayrollPeriod("2026-12-10", settings).holidayCoverageComplete, false,
    "December needs the next annual notice even when payday is in the same month");
  installHolidayData([newer, old]);
  assert.equal(getPayrollPeriod("2026-12-10", settings).holidayCoverageComplete, true);
  assert.deepEqual(getHolidayYears(), [2026, 2027]);
  assert.deepEqual(getPublicHoliday("2026-12-31"), { kind: "rest", name: "元旦" });
  settings.overrides["2026-12-31"] = "work";
  assert.equal(isWorkday("2026-12-31", settings), true, "company override remains authoritative");
});

test("a replacement snapshot removes obsolete dates, preserves atomicity and never shares mutable data", () => {
  const initial = yearData();
  installHolidayData([initial]);
  initial.days[0].isOffDay = false;
  const exposed = getPublicHoliday("2026-01-01")!;
  exposed.kind = "work";
  const years = getHolidayYears();
  years.push(2099);
  assert.deepEqual(getPublicHoliday("2026-01-01"), { kind: "rest", name: "元旦" });
  assert.deepEqual(getHolidayYears(), [2026]);
  assert.throws(() => installHolidayData([yearData(), yearData()]));
  assert.throws(() => installHolidayData([{ ...yearData(), days: [] }]));
  assert.equal(getPublicHoliday("2026-10-01")?.kind, "rest");
  const replacement = yearData();
  replacement.days = replacement.days.filter((day) => day.date !== "2026-10-01");
  replacement.days.find((day) => day.date === "2026-10-10")!.name = "国庆节补班";
  installHolidayData([replacement]);
  assert.equal(getPublicHoliday("2026-10-01"), null);
  assert.equal(getPublicHoliday("2026-10-10")?.name, "国庆节补班");
  installHolidayData([]);
  assert.deepEqual(getHolidayYears(), []);
  assert.equal(getPublicHoliday("2026-10-10"), null);
});

test("a calendar update refreshes future denominators and coverage without repricing recorded work", () => {
  installHolidayData(fixture);
  let data = emptyData();
  data = startWork(data, localTime("2026-10-09", "09:00"));
  const plan = structuredClone(data.records["2026-10-09"].plan);
  const before = getDaySummary(data, localTime("2026-10-09", "10:00"));
  assert.equal(plan.workdays, 18);
  assert.equal(getPayrollPeriod("2026-11-10", data.settings).holidayCoverageComplete, true);
  const changed = structuredClone(fixture) as HolidayYearData[];
  changed[0].days.push({ date: "2026-10-12", name: "新增放假", isOffDay: true });
  installHolidayData(changed);
  assert.equal(getDayPlan("2026-10-13", data.settings).workdays, 17);
  assert.deepEqual(data.records["2026-10-09"].plan, plan);
  assert.equal(getDaySummary(data, localTime("2026-10-09", "10:00")).earnings, before.earnings);
  assert.deepEqual(normalizeData(JSON.parse(JSON.stringify(data))).records["2026-10-09"].plan, plan);
  installHolidayData([changed[0]]);
  assert.equal(getPayrollPeriod("2027-03-01", data.settings).holidayCoverageComplete, false);
});

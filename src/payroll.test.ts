import assert from "node:assert/strict";
import test from "node:test";
import holidayFixture from "../tests/fixtures/china-holidays.json";
import { installHolidayData } from "./holidays";
import {
  defaultSettings,
  emptyData,
  finishWork,
  getDayPlan,
  getNextPayday,
  getPayrollPeriod,
  isWorkday,
  periodEarnings,
  shiftPayrollPeriod,
  startWork,
} from "./core";

installHolidayData(holidayFixture);

// Independent calendar iteration for invariant checks (not payroll implementation helpers).
const addDays = (key: string, count: number) =>
  new Date(Date.parse(`${key}T00:00:00Z`) + count * 86_400_000)
    .toISOString()
    .slice(0, 10);
const localTime = (key: string, hhmm: string) =>
  new Date(`${key}T${hhmm}:00`).getTime();

test("monthly cycles form a gapless partition through leap years and clamped 29–31 anchors", () => {
  const settings = defaultSettings();
  settings.publicHolidays = false;
  for (const startDay of [1, 15, 26, 28, 29, 30, 31]) {
    settings.payroll.cycleStartDay = startDay;
    for (const year of [2024, 2025, 2026, 2027, 2028]) {
      for (let month = 1; month <= 12; month++) {
        const key = `${year}-${String(month).padStart(2, "0")}-15`;
        const period = getPayrollPeriod(key, settings);
        assert.ok(period.start <= key && key <= period.end, `${startDay}: ${key}`);
        const next = shiftPayrollPeriod(period, 1, settings);
        assert.equal(next.start, addDays(period.end, 1), `${startDay}: ${key}`);
        assert.equal(shiftPayrollPeriod(next, -1, settings).start, period.start);
        assert.equal(getPayrollPeriod(period.start, settings).start, period.start);
        assert.equal(getPayrollPeriod(period.end, settings).start, period.start);
      }
    }
  }
  settings.payroll.cycleStartDay = 31;
  assert.deepEqual(
    ["2024-02-28", "2024-02-29"].map(key => {
      const { start, end } = getPayrollPeriod(key, settings);
      return [start, end];
    }),
    [["2024-01-31", "2024-02-28"], ["2024-02-29", "2024-03-30"]],
  );
});

test("working every full scheduled day in a non-calendar cycle earns one monthly salary", () => {
  const settings = defaultSettings();
  settings.payroll.cycleStartDay = 26;
  settings.monthlySalary = 23789;
  const period = getPayrollPeriod("2026-10-10", settings);
  let wage = 0;
  let workdays = 0;
  for (let key = period.start; key <= period.end; key = addDays(key, 1)) {
    const plan = getDayPlan(key, settings);
    assert.equal(plan.periodStart, period.start);
    assert.equal(plan.periodEnd, period.end);
    assert.equal(plan.workdays, period.workdays);
    if (isWorkday(key, settings)) {
      workdays++;
      wage += plan.dailyWage;
    }
  }
  assert.equal(workdays, period.workdays);
  assert.ok(Math.abs(wage - settings.monthlySalary) < 1e-8);
});

test("next payday includes today, but drops a future nominal date already advanced into the past", () => {
  const settings = defaultSettings();
  settings.payroll.payDay = 5;
  settings.payroll.holidayAdjustment = "previous";
  const today = getNextPayday("2026-09-30", settings)!;
  assert.equal(today.start, "2026-09-01");
  assert.equal(today.nominalPayday, "2026-10-05");
  assert.equal(today.actualPayday, "2026-09-30");
  assert.equal(today.daysUntil, 0);
  assert.equal(getNextPayday("2026-10-01", settings)!.actualPayday, "2026-11-05");
});

test("a long closure retains the oldest delayed payment when several periods land on the same workday", () => {
  const settings = defaultSettings();
  settings.publicHolidays = false;
  settings.payroll.holidayAdjustment = "next";
  for (let key = "2026-01-01"; key < "2026-12-01"; key = addDays(key, 1)) {
    settings.overrides[key] = "rest";
  }
  const next = getNextPayday("2026-06-01", settings)!;
  assert.equal(next.actualPayday, "2026-12-01");
  assert.equal(next.start, "2025-12-01");
  assert.equal(next.nominalPayday, "2026-01-15");
  assert.equal(next.daysUntil, 183);
});

test("short-month payday clamping and makeup days use the nearest valid day in the chosen direction", () => {
  const settings = defaultSettings();
  settings.payroll.payDay = 31;
  settings.payroll.payMonthOffset = 2;
  settings.payroll.holidayAdjustment = "next";
  const december = getPayrollPeriod("2026-12-15", settings);
  assert.equal(december.nominalPayday, "2027-02-28");
  assert.equal(december.actualPayday, "2027-03-01");
  assert.equal(december.adjustmentDays, 1);
  settings.payroll.payDay = 8;
  settings.payroll.payMonthOffset = 1;
  settings.overrides["2026-10-08"] = "rest";
  settings.overrides["2026-10-09"] = "rest";
  const september = getPayrollPeriod("2026-09-15", settings);
  assert.equal(september.actualPayday, "2026-10-10", "official makeup Saturday is a working day");
  assert.equal(september.adjustmentDays, 2);
});

test("cycle earnings include each boundary day once and preserve recorded rates after rule changes", () => {
  let data = emptyData();
  data.settings.payroll.cycleStartDay = 26;
  for (const key of ["2026-11-25", "2026-11-26"]) {
    data = startWork(data, localTime(key, "09:00"));
    data = finishWork(data, localTime(key, "10:00"));
  }
  const first = data.records["2026-11-25"].plan.perSecond * 3600;
  const second = data.records["2026-11-26"].plan.perSecond * 3600;
  const now = localTime("2026-12-01", "12:00");
  assert.equal(periodEarnings(data, "2026-10-26", "2026-11-25", now), first);
  assert.equal(periodEarnings(data, "2026-11-26", "2026-12-25", now), second);
  data.settings.monthlySalary *= 2;
  data.settings.payroll.cycleStartDay = 1;
  assert.equal(periodEarnings(data, "2026-11-01", "2026-11-30", now), first + second);
});

test("day countdowns remain calendar based around daylight-saving changes", () => {
  const settings = defaultSettings();
  settings.publicHolidays = false;
  settings.payroll.payDay = 9;
  settings.payroll.holidayAdjustment = "next";
  const next = getNextPayday("2026-03-07", settings)!;
  assert.equal(next.actualPayday, "2026-03-09");
  assert.equal(next.daysUntil, 2);
});

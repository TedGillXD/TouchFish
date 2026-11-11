import assert from "node:assert/strict";
import test from "node:test";
import holidayFixture from "../tests/fixtures/china-holidays.json";
import { installHolidayData } from "./holidays";
import {
  countWorkdays,
  dateKey,
  emptyData,
  finishWork,
  getDayPlan,
  getDaySummary,
  getPayrollPeriod,
  getNextPayday,
  isWorkday,
  isWeeklyRestDay,
  monthDays,
  monthEarnings,
  normalizeData,
  normalizeSettings,
  pauseWork,
  periodEarnings,
  reconcileData,
  startWork,
  shiftPayrollPeriod,
  validateSettings,
} from "./core";

// Payroll rules are tested against explicit data, never an application bundle.
installHolidayData(holidayFixture);

const time = (key: string, hhmm: string) =>
  new Date(`${key}T${hhmm}:00`).getTime();
const fixture = () => {
  const data = emptyData();
  data.settings.alternateAnchor = "2026-10-26";
  return data;
};

test("counts leap-year month and configurable single rest day", () => {
  const { settings } = fixture();
  assert.equal(monthDays(2024, 2, settings).length, 29);
  assert.equal(countWorkdays(2024, 2, settings), 21);
  settings.scheduleMode = "single";
  assert.equal(countWorkdays(2024, 2, settings), 25);
  settings.restDay = 3;
  assert.equal(isWorkday("2024-02-07", settings), false);
  assert.equal(isWorkday("2024-02-04", settings), true);
});

test("alternate pattern continues across month and year boundaries, including before anchor", () => {
  const { settings } = fixture();
  settings.scheduleMode = "alternate";
  assert.equal(isWorkday("2026-10-31", settings), false);
  assert.equal(isWorkday("2026-11-07", settings), true);
  assert.equal(isWorkday("2026-11-14", settings), false);
  assert.equal(isWorkday("2026-10-24", settings), true);
  settings.alternateAnchor = "2026-12-28";
  assert.equal(isWorkday("2027-01-02", settings), false);
  assert.equal(isWorkday("2027-01-09", settings), true);
});

test("custom double rest days migrate safely and validate only relevant weekly rules", () => {
  const legacy = JSON.parse(JSON.stringify(fixture().settings));
  delete legacy.doubleRestDays;
  assert.deepEqual(normalizeSettings(legacy).doubleRestDays, [6, 0]);
  for (const doubleRestDays of [null, "1,2", [], [1], [1, 2, 3], [1, 1], [1, 7], [-1, 2], [1.5, 2], [1, "2"], [NaN, 2]])
    assert.deepEqual(normalizeSettings({ ...legacy, doubleRestDays }).doubleRestDays, [6, 0]);
  const input = { ...legacy, doubleRestDays: [0, 1] };
  const normalized = normalizeSettings(input);
  assert.deepEqual(normalized.doubleRestDays, [1, 0], "weekdays use Monday-to-Sunday order");
  input.doubleRestDays[0] = 5;
  assert.deepEqual(normalized.doubleRestDays, [1, 0], "normalization owns its array");
  const { settings } = fixture();
  settings.doubleRestDays = [1, 2];
  settings.payroll.holidayAdjustment = "none";
  assert.deepEqual(validateSettings(settings), []);
  assert.equal(normalizeSettings(settings).payroll.holidayAdjustment, "none");
  settings.doubleRestDays = [1];
  assert.match(validateSettings(settings).join(" "), /两个不同的休息日/);
  settings.scheduleMode = "single";
  assert.deepEqual(validateSettings(settings), [], "an unused double-week draft does not block single rest");
});

test("Monday-Tuesday rest makes weekends working and changes cycle wage denominators", () => {
  const { settings } = fixture();
  settings.publicHolidays = false;
  settings.doubleRestDays = [1, 2];
  for (const key of ["2026-11-09", "2026-11-10"]) {
    assert.equal(isWeeklyRestDay(key, settings), true);
    assert.equal(isWorkday(key, settings), false);
  }
  for (const key of ["2026-11-11", "2026-11-14", "2026-11-15"])
    assert.equal(isWorkday(key, settings), true);
  assert.equal(countWorkdays(2026, 12, settings), 22);
  settings.payroll.cycleStartDay = 26;
  const period = getPayrollPeriod("2026-11-11", settings);
  assert.equal(period.start, "2026-10-26");
  assert.equal(period.end, "2026-11-25");
  assert.equal(period.workdays, 21);
  assert.equal(getDayPlan("2026-11-14", settings).dailyWage, 15000 / 21);
});

test("custom rest days retain official makeup and manual override precedence", () => {
  const { settings } = fixture();
  settings.doubleRestDays = [1, 2];
  assert.equal(isWorkday("2026-10-01", settings), false, "Thursday's public holiday beats a normal shift");
  settings.overrides["2026-10-01"] = "work";
  settings.overrides["2026-11-09"] = "work";
  assert.equal(isWorkday("2026-10-01", settings), true);
  assert.equal(isWorkday("2026-11-09", settings), true);
  settings.doubleRestDays = [0, 1];
  assert.equal(isWeeklyRestDay("2026-01-04", settings), true);
  assert.equal(isWorkday("2026-01-04", settings), true, "Sunday's official makeup overrides weekly rest");
  settings.overrides["2026-01-04"] = "rest";
  assert.equal(isWorkday("2026-01-04", settings), false);
  delete settings.overrides["2026-01-04"];
  settings.publicHolidays = false;
  assert.equal(isWorkday("2026-01-04", settings), false);
});

test("alternate custom rest days rotate on both sides of the anchor and across New Year", () => {
  const { settings } = fixture();
  settings.publicHolidays = false;
  settings.scheduleMode = "alternate";
  settings.doubleRestDays = [1, 2];
  settings.restDay = 3;
  settings.alternateAnchor = "2026-12-28";
  for (const key of ["2026-12-14", "2026-12-15", "2026-12-28", "2026-12-29", "2027-01-06"])
    assert.equal(isWorkday(key, settings), false, key);
  for (const key of ["2026-12-16", "2026-12-21", "2026-12-22", "2026-12-30", "2027-01-02", "2027-01-04"])
    assert.equal(isWorkday(key, settings), true, key);
  assert.equal(isWorkday("2026-12-23", settings), false);
  settings.alternateAnchor = "2027-01-04";
  assert.equal(isWorkday("2026-12-28", settings), true);
  assert.equal(isWorkday("2027-01-04", settings), false);
  assert.equal(isWorkday("2027-01-06", settings), true);
});

test("changing weekly rest and same-day payday never reprices an already started record", () => {
  let data = fixture();
  data.settings.publicHolidays = false;
  data.settings.payroll.cycleStartDay = 26;
  data = startWork(data, time("2026-11-09", "09:00"));
  data = pauseWork(data, time("2026-11-09", "10:00"));
  const original = structuredClone(data.records["2026-11-09"].plan);
  const earned = getDaySummary(data, time("2026-11-09", "11:00")).earnings;
  assert.equal(original.workdays, 23);
  data.settings.doubleRestDays = [1, 2];
  data.settings.payroll.holidayAdjustment = "none";
  const restored = normalizeData(JSON.parse(JSON.stringify(data)));
  assert.deepEqual(restored.settings.doubleRestDays, [1, 2]);
  assert.equal(restored.settings.payroll.holidayAdjustment, "none");
  assert.deepEqual(restored.records["2026-11-09"].plan, original);
  assert.equal(getDaySummary(restored, time("2026-11-09", "11:00")).earnings, earned);
  assert.equal(getDayPlan("2026-11-10", restored.settings).working, false);
  assert.equal(getDayPlan("2026-11-14", restored.settings).workdays, 21);
  const legacy = JSON.parse(JSON.stringify(restored));
  delete legacy.settings.doubleRestDays;
  const old = normalizeData(legacy);
  assert.deepEqual(old.settings.doubleRestDays, [6, 0]);
  assert.deepEqual(old.records["2026-11-09"].plan, original);
});

test("date overrides determine denominator and work status", () => {
  const { settings } = fixture();
  const initial = countWorkdays(2026, 11, settings);
  settings.overrides["2026-11-07"] = "work";
  settings.overrides["2026-11-10"] = "rest";
  assert.equal(countWorkdays(2026, 11, settings), initial);
  assert.equal(isWorkday("2026-11-07", settings), true);
  assert.equal(isWorkday("2026-11-10", settings), false);
});

test("manual start, pauses and resumes count only paid seconds once", () => {
  let data = fixture();
  const day = "2026-11-10";
  data = startWork(data, time(day, "09:30"));
  assert.equal(getDaySummary(data, time(day, "10:00")).seconds, 1800);
  assert.equal(
    startWork(data, time(day, "09:45")),
    data,
    "repeated start is idempotent",
  );
  data = pauseWork(data, time(day, "10:00"));
  assert.equal(getDaySummary(data, time(day, "10:30")).seconds, 1800);
  data = startWork(data, time(day, "10:30"));
  assert.equal(getDaySummary(data, time(day, "11:00")).seconds, 3600);
  data = finishWork(data, time(day, "11:00"));
  assert.equal(getDaySummary(data, time(day, "11:30")).status, "completed");
  assert.equal(
    startWork(data, time(day, "12:00")),
    data,
    "finished day cannot restart",
  );
});

test("lunch excluded, before-start clipped and scheduled end caps daily wages", () => {
  let data = fixture();
  const day = "2026-11-10";
  data = startWork(data, time(day, "08:30"));
  assert.equal(getDaySummary(data, time(day, "08:59")).seconds, 0);
  assert.equal(getDaySummary(data, time(day, "12:30")).seconds, 3 * 3600);
  const full = getDaySummary(data, time(day, "23:59"));
  assert.equal(full.seconds, 8 * 3600);
  assert.equal(full.earnings, full.dailyWage);
  assert.equal(full.progress, 1);
  assert.equal(full.status, "completed");
  data = reconcileData(data, time(day, "18:01"));
  assert.equal(data.records[day].intervals[0].to, time(day, "18:00"));
});

test("payroll and schedule snapshots survive settings edits and disk roundtrip", () => {
  let data = startWork(fixture(), time("2026-11-10", "09:00"));
  const rate = data.records["2026-11-10"].plan.perSecond;
  data = {
    ...data,
    settings: {
      ...data.settings,
      monthlySalary: 99999,
      weekdayHours: {
        ...data.settings.weekdayHours,
        2: { start: "09:00", end: "20:00" },
      },
    },
  };
  data = normalizeData(JSON.parse(JSON.stringify(data)));
  assert.equal(
    getDaySummary(data, time("2026-11-10", "10:00")).earnings,
    rate * 3600,
  );
  assert.equal(
    data.records["2026-11-10"].plan.end,
    time("2026-11-10", "18:00"),
  );
  assert.equal(getDayPlan("2026-11-11", data.settings).dailyWage, 99999 / 21);
});

test("restart/rollover settles old record and requires a new manual start", () => {
  let data = startWork(fixture(), time("2026-11-10", "09:00"));
  data = normalizeData(JSON.parse(JSON.stringify(data)));
  assert.equal(getDaySummary(data, time("2026-11-10", "10:00")).seconds, 3600);
  data = reconcileData(data, time("2026-11-11", "10:00"));
  assert.equal(data.records["2026-11-10"].completed, true);
  assert.equal(getDaySummary(data, time("2026-11-11", "10:00")).status, "idle");
  assert.equal(getDaySummary(data, time("2026-11-11", "10:00")).earnings, 0);
  assert.equal(
    monthEarnings(data, 2026, 11, time("2026-11-11", "10:00")),
    data.records["2026-11-10"].plan.dailyWage,
  );
});

test("weekday-specific end time changes daily rate and runtime cutoff", () => {
  let data = fixture();
  data.settings.weekdayHours[3] = { start: "09:00", end: "17:00" };
  data = startWork(data, time("2026-11-11", "09:00"));
  const summary = getDaySummary(data, time("2026-11-11", "18:00"));
  assert.equal(summary.seconds, 7 * 3600);
  assert.equal(summary.earnings, summary.dailyWage);
  assert.equal(summary.plan.end, time("2026-11-11", "17:00"));
});

test("rest days and after-hours start do not create a record", () => {
  const data = fixture();
  assert.equal(startWork(data, time("2026-11-08", "10:00")), data);
  assert.equal(startWork(data, time("2026-11-10", "18:00")), data);
  assert.equal(getDaySummary(data, time("2026-11-08", "10:00")).status, "rest");
});

test("corrupt storage normalizes to finite safe state and duplicate ranges never double count", () => {
  assert.equal(normalizeData(null).version, 1);
  const data = startWork(fixture(), time("2026-11-10", "09:00"));
  data.settings.monthlySalary = Number.NaN;
  data.records["2026-11-10"].intervals.push({
    from: time("2026-11-10", "09:30"),
    to: time("2026-11-10", "10:00"),
  });
  const normalized = normalizeData(data);
  assert.equal(normalized.settings.monthlySalary, 15000);
  assert.equal(
    getDaySummary(normalized, time("2026-11-10", "10:00")).seconds,
    3600,
  );
  assert.equal(dateKey(new Date(2026, 10, 10)), "2026-11-10");
});

test("rejects zero payable hours and invalid daytime ranges in form validation", () => {
  const { settings } = fixture();
  settings.weekdayHours[3] = { start: "12:00", end: "13:00" };
  assert.match(validateSettings(settings).join(" "), /计薪时长不能为零/);
  settings.weekdayHours[3] = { start: "18:00", end: "09:00" };
  assert.match(validateSettings(settings).join(" "), /下班时间必须晚于/);
});

test("alternate anchor validation requires Monday to match the form label", () => {
  const { settings } = fixture();
  settings.scheduleMode = "alternate";
  settings.alternateAnchor = "2026-11-10";
  assert.match(validateSettings(settings).join(" "), /双休周的周一/);
  settings.alternateAnchor = "2026-11-09";
  assert.deepEqual(validateSettings(settings), []);
});

test("clock rollback never removes already closed earnings or pays an overlapping interval twice", () => {
  const day = "2026-11-10";
  let data = startWork(fixture(), time(day, "09:00"));
  data = pauseWork(data, time(day, "10:00"));
  assert.equal(getDaySummary(data, time(day, "09:30")).seconds, 3600);
  assert.equal(
    monthEarnings(data, 2026, 11, time("2026-11-09", "09:00")),
    data.records[day].plan.perSecond * 3600,
  );
  data = startWork(data, time(day, "09:30"));
  assert.equal(getDaySummary(data, time(day, "10:00")).seconds, 3600);
  assert.equal(getDaySummary(data, time(day, "10:30")).seconds, 5400);
});

test("dinner stops accrual at 18:00, resumes at 19:00, and full-day earnings still reach the daily target", () => {
  let data = fixture();
  const day = "2026-11-10";
  data.settings.weekdayHours[2].end = "21:00";
  const plan = getDayPlan(day, data.settings);
  assert.equal(plan.plannedSeconds, 10 * 3600);
  assert.equal(plan.dinnerStart, time(day, "18:00"));
  assert.equal(plan.dinnerEnd, time(day, "19:00"));
  data = startWork(data, time(day, "09:00"));
  assert.equal(getDaySummary(data, time(day, "18:00")).seconds, 8 * 3600);
  assert.equal(getDaySummary(data, time(day, "18:59")).seconds, 8 * 3600);
  assert.equal(getDaySummary(data, time(day, "19:30")).seconds, 8.5 * 3600);
  const full = getDaySummary(data, time(day, "22:00"));
  assert.equal(full.seconds, 10 * 3600);
  assert.equal(full.earnings, full.dailyWage);
  assert.equal(full.progress, 1);
});

test("dinner is clipped to the shift, excluded outside it, and can be disabled", () => {
  const { settings } = fixture();
  const day = "2026-11-10";
  assert.equal(getDayPlan(day, settings).dinnerStart, null);
  assert.equal(getDayPlan(day, settings).plannedSeconds, 8 * 3600);
  settings.weekdayHours[2].end = "18:30";
  const partial = getDayPlan(day, settings);
  assert.equal(partial.dinnerStart, time(day, "18:00"));
  assert.equal(partial.dinnerEnd, time(day, "18:30"));
  assert.equal(partial.plannedSeconds, 8 * 3600);
  settings.dinner.enabled = false;
  assert.equal(getDayPlan(day, settings).dinnerStart, null);
  assert.equal(getDayPlan(day, settings).plannedSeconds, 8.5 * 3600);
  settings.dinner.enabled = true;
  settings.weekdayHours[2] = { start: "19:30", end: "21:00" };
  assert.equal(getDayPlan(day, settings).dinnerStart, null);
  assert.equal(getDayPlan(day, settings).plannedSeconds, 1.5 * 3600);
});

test("overlapping and adjacent lunch/dinner breaks are merged without double deduction", () => {
  const day = "2026-11-10";
  let data = fixture();
  data.settings.dinner = { enabled: true, start: "12:30", end: "13:30" };
  data = startWork(data, time(day, "09:00"));
  assert.equal(data.records[day].plan.plannedSeconds, 7.5 * 3600);
  assert.equal(getDaySummary(data, time(day, "13:15")).seconds, 3 * 3600);
  assert.equal(getDaySummary(data, time(day, "14:00")).seconds, 3.5 * 3600);
  assert.equal(getDaySummary(data, time(day, "18:00")).seconds, 7.5 * 3600);
  const disk = normalizeData(JSON.parse(JSON.stringify(data)));
  assert.equal(disk.records[day].plan.plannedSeconds, 7.5 * 3600);
  assert.equal(getDaySummary(disk, time(day, "14:00")).seconds, 3.5 * 3600);
  data = fixture();
  data.settings.dinner = { enabled: true, start: "13:00", end: "14:00" };
  data = startWork(data, time(day, "09:00"));
  assert.equal(getDaySummary(data, time(day, "13:59")).seconds, 3 * 3600);
  assert.equal(getDaySummary(data, time(day, "18:00")).seconds, 7 * 3600);
});

test("manual pauses across both meal periods only pay selected non-break time", () => {
  const day = "2026-11-10";
  let data = fixture();
  data.settings.weekdayHours[2].end = "21:00";
  data = startWork(data, time(day, "11:30"));
  data = pauseWork(data, time(day, "12:15"));
  assert.equal(getDaySummary(data, time(day, "18:30")).seconds, 1800);
  data = startWork(data, time(day, "18:30"));
  assert.equal(getDaySummary(data, time(day, "18:59")).seconds, 1800);
  assert.equal(getDaySummary(data, time(day, "19:30")).seconds, 3600);
});

test("settings reject invalid dinner periods and combined all-day unpaid breaks", () => {
  const { settings } = fixture();
  settings.dinner = { enabled: true, start: "19:00", end: "18:00" };
  assert.match(validateSettings(settings).join(" "), /晚饭结束时间必须晚于/);
  settings.dinner.enabled = false;
  assert.deepEqual(validateSettings(settings), []);
  settings.lunch = { enabled: true, start: "09:00", end: "13:00" };
  settings.dinner = { enabled: true, start: "13:00", end: "18:00" };
  assert.match(validateSettings(settings).join(" "), /计薪时长不能为零/);
  settings.dinner.start = "12:00";
  assert.match(validateSettings(settings).join(" "), /计薪时长不能为零/);
});

test("legacy settings gain dinner/holiday defaults while legacy snapshots keep their original earnings", () => {
  const day = "2026-10-09";
  let data = fixture();
  data.settings.publicHolidays = false;
  data.settings.dinner.enabled = false;
  data.settings.weekdayHours[5].end = "21:00";
  data = startWork(data, time(day, "09:00"));
  data = pauseWork(data, time(day, "20:00"));
  const original = getDaySummary(data, time(day, "20:00"));
  const raw = JSON.parse(JSON.stringify(data));
  delete raw.settings.dinner;
  delete raw.settings.publicHolidays;
  delete raw.records[day].plan.dinnerStart;
  delete raw.records[day].plan.dinnerEnd;
  const restored = normalizeData(raw);
  assert.deepEqual(restored.settings.dinner, {
    enabled: true,
    start: "18:00",
    end: "19:00",
  });
  assert.equal(restored.settings.publicHolidays, true);
  assert.equal(restored.records[day].plan.dinnerStart, null);
  assert.equal(restored.records[day].plan.dinnerEnd, null);
  assert.equal(
    restored.records[day].plan.plannedSeconds,
    original.plannedSeconds,
  );
  assert.equal(restored.records[day].plan.workdays, original.plan.workdays);
  assert.equal(
    getDaySummary(restored, time(day, "20:00")).earnings,
    original.earnings,
  );
  assert.equal(restored.records[day].plan.perSecond, original.perSecond);
});

test("dinner and holiday preference persist and invalid storage never invents extra breaks", () => {
  const data = fixture();
  data.settings.dinner = { enabled: true, start: "17:45", end: "18:45" };
  data.settings.publicHolidays = false;
  assert.deepEqual(
    normalizeData(JSON.parse(JSON.stringify(data))).settings,
    data.settings,
  );
  const settings = normalizeSettings({
    dinner: { enabled: false, start: "invalid", end: "invalid" },
  });
  assert.equal(settings.dinner.enabled, false);
  assert.equal(settings.dinner.start, "18:00");
  assert.equal(settings.publicHolidays, true);
});

test("official public holidays and makeup workdays take precedence over weekly patterns", () => {
  const { settings } = fixture();
  for (const scheduleMode of ["double", "single", "alternate"] as const) {
    settings.scheduleMode = scheduleMode;
    assert.equal(isWorkday("2026-10-01", settings), false, scheduleMode);
    assert.equal(isWorkday("2026-10-07", settings), false, scheduleMode);
    assert.equal(isWorkday("2026-10-10", settings), true, scheduleMode);
  }
  settings.scheduleMode = "double";
  settings.publicHolidays = false;
  assert.equal(isWorkday("2026-10-01", settings), true);
  assert.equal(isWorkday("2026-10-10", settings), false);
});

test("manual overrides beat official holidays and the monthly denominator uses the resulting calendar", () => {
  const { settings } = fixture();
  assert.equal(countWorkdays(2026, 10, settings), 18);
  const plan = getDayPlan("2026-10-09", settings);
  assert.equal(plan.workdays, 18);
  assert.equal(plan.dailyWage, settings.monthlySalary / 18);
  settings.overrides["2026-10-01"] = "work";
  assert.equal(isWorkday("2026-10-01", settings), true);
  assert.equal(countWorkdays(2026, 10, settings), 19);
  settings.overrides["2026-10-10"] = "rest";
  assert.equal(isWorkday("2026-10-10", settings), false);
  assert.equal(countWorkdays(2026, 10, settings), 18);
});

test("monthly payroll periods contain their boundary dates and keep the default calendar month", () => {
  const { settings } = fixture();
  const ordinary = getPayrollPeriod("2026-11-10", settings);
  assert.equal(ordinary.start, "2026-11-01");
  assert.equal(ordinary.end, "2026-11-30");
  assert.equal(ordinary.workdays, countWorkdays(2026, 11, settings));
  assert.equal(ordinary.nominalPayday, "2026-12-15");
  settings.payroll.cycleStartDay = 26;
  const period = getPayrollPeriod("2026-11-10", settings);
  assert.equal(period.start, "2026-10-26");
  assert.equal(period.end, "2026-11-25");
  assert.equal(getPayrollPeriod("2026-11-25", settings).start, period.start);
  assert.equal(getPayrollPeriod("2026-11-26", settings).start, "2026-11-26");
  assert.equal(shiftPayrollPeriod(period, -1, settings).start, "2026-09-26");
  assert.equal(shiftPayrollPeriod(period, 1, settings).start, "2026-11-26");
});

test("31st-day anchors clamp each month independently without gaps, overlap, or navigation drift", () => {
  const { settings } = fixture();
  settings.payroll.cycleStartDay = 31;
  const january = getPayrollPeriod("2026-02-10", settings);
  assert.deepEqual([january.start, january.end], ["2026-01-31", "2026-02-27"]);
  const february = shiftPayrollPeriod(january, 1, settings);
  assert.deepEqual(
    [february.start, february.end],
    ["2026-02-28", "2026-03-30"],
  );
  const march = shiftPayrollPeriod(february, 1, settings);
  assert.deepEqual([march.start, march.end], ["2026-03-31", "2026-04-29"]);
  assert.equal(shiftPayrollPeriod(february, -1, settings).start, january.start);
  assert.equal(getPayrollPeriod("2026-02-27", settings).start, january.start);
  assert.equal(getPayrollPeriod("2026-02-28", settings).start, february.start);
  const leap = getPayrollPeriod("2024-03-01", settings);
  assert.deepEqual([leap.start, leap.end], ["2024-02-29", "2024-03-30"]);
});

test("daily wages use workdays across the entire selected cycle and sum to the monthly salary", () => {
  const { settings } = fixture();
  settings.payroll.cycleStartDay = 26;
  const period = getPayrollPeriod("2026-11-10", settings);
  assert.equal(period.workdays, 23);
  const day = getDayPlan("2026-11-10", settings);
  assert.equal(day.workdays, 23);
  assert.equal(day.dailyWage, 15000 / 23);
  assert.equal(day.periodStart, period.start);
  assert.equal(day.periodEnd, period.end);
  let total = 0;
  for (
    let date = new Date(2026, 9, 26);
    dateKey(date) <= period.end;
    date.setDate(date.getDate() + 1)
  ) {
    if (isWorkday(dateKey(date), settings))
      total += getDayPlan(dateKey(date), settings).dailyWage;
  }
  assert.ok(Math.abs(total - settings.monthlySalary) < 1e-8);
  settings.overrides["2026-11-07"] = "work";
  assert.equal(getPayrollPeriod("2026-11-10", settings).workdays, 24);
  assert.equal(getDayPlan("2026-11-10", settings).dailyWage, 15000 / 24);
});

test("payday month offsets use the period end month and missing month days become month end", () => {
  const { settings } = fixture();
  settings.payroll.cycleStartDay = 26;
  settings.payroll.payDay = 31;
  let period = getPayrollPeriod("2026-01-10", settings);
  assert.equal(period.end, "2026-01-25");
  assert.equal(period.nominalPayday, "2026-02-28");
  assert.equal(
    period.actualPayday,
    "2026-02-28",
    "announced Saturday makeup workday stays a payday",
  );
  settings.payroll.payMonthOffset = 0;
  period = getPayrollPeriod("2026-01-10", settings);
  assert.equal(period.nominalPayday, "2026-01-31");
  settings.payroll.payMonthOffset = 2;
  assert.equal(
    getPayrollPeriod("2026-01-10", settings).nominalPayday,
    "2026-03-31",
  );
  settings.payroll.cycleStartDay = 1;
  settings.payroll.payMonthOffset = 1;
  assert.equal(
    getPayrollPeriod("2024-01-10", settings).nominalPayday,
    "2024-02-29",
  );
});

test("paydays move to the closest selected-direction workday across national holidays and a year boundary", () => {
  const { settings } = fixture();
  settings.payroll.payDay = 5;
  let period = getPayrollPeriod("2026-09-15", settings);
  assert.equal(period.nominalPayday, "2026-10-05");
  assert.equal(period.actualPayday, "2026-09-30");
  assert.equal(period.adjustmentDays, -5);
  settings.payroll.holidayAdjustment = "next";
  period = getPayrollPeriod("2026-09-15", settings);
  assert.equal(period.actualPayday, "2026-10-08");
  assert.equal(period.adjustmentDays, 3);
  settings.payroll.payDay = 1;
  settings.payroll.holidayAdjustment = "previous";
  period = getPayrollPeriod("2026-12-10", settings);
  assert.equal(period.nominalPayday, "2027-01-01");
  assert.equal(period.actualPayday, "2026-12-31");
  assert.equal(period.holidayCoverageComplete, true);
  settings.payroll.holidayAdjustment = "next";
  assert.equal(
    getPayrollPeriod("2026-12-10", settings).actualPayday,
    "2027-01-04",
  );
});

test("payday uses the configured weekly rest day and manual overrides before official arrangements", () => {
  const { settings } = fixture();
  let period = getPayrollPeriod("2026-10-15", settings);
  assert.equal(period.nominalPayday, "2026-11-15");
  assert.equal(period.actualPayday, "2026-11-13");
  settings.overrides["2026-11-14"] = "work";
  assert.equal(
    getPayrollPeriod("2026-10-15", settings).actualPayday,
    "2026-11-14",
  );
  settings.overrides["2026-11-15"] = "work";
  assert.equal(
    getPayrollPeriod("2026-10-15", settings).actualPayday,
    "2026-11-15",
  );
  settings.overrides = {};
  settings.scheduleMode = "single";
  settings.restDay = 5;
  assert.equal(
    getPayrollPeriod("2026-10-15", settings).actualPayday,
    "2026-11-15",
    "Sunday is working under Friday-only rest",
  );
});

test("next payday includes today and can belong to the previous earning period", () => {
  const { settings } = fixture();
  let next = getNextPayday("2026-11-10", settings)!;
  assert.equal(next.start, "2026-10-01");
  assert.equal(next.end, "2026-10-31");
  assert.equal(next.actualPayday, "2026-11-13");
  assert.equal(next.daysUntil, 3);
  next = getNextPayday("2026-11-13", settings)!;
  assert.equal(next.actualPayday, "2026-11-13");
  assert.equal(next.daysUntil, 0);
  next = getNextPayday("2026-11-14", settings)!;
  assert.equal(next.actualPayday, "2026-12-15");
  assert.equal(next.start, "2026-11-01");
});

test("next payday considers very old delayed payouts and skips future nominal paydays already advanced", () => {
  const { settings } = fixture();
  settings.publicHolidays = false;
  settings.payroll.payDay = 1;
  settings.payroll.holidayAdjustment = "next";
  for (
    let date = new Date(2026, 1, 1);
    dateKey(date) <= "2026-11-20";
    date.setDate(date.getDate() + 1)
  )
    settings.overrides[dateKey(date)] = "rest";
  const next = getNextPayday("2026-11-10", settings)!;
  assert.equal(next.start, "2026-01-01");
  assert.equal(next.nominalPayday, "2026-02-01");
  assert.equal(next.actualPayday, "2026-11-23");
  settings.overrides = {};
  settings.payroll.payDay = 15;
  settings.payroll.holidayAdjustment = "previous";
  for (let day = 1; day <= 30; day++)
    settings.overrides[dateKey(new Date(2026, 10, day))] = "rest";
  const advanced = getNextPayday("2026-11-10", settings)!;
  assert.equal(advanced.nominalPayday, "2026-12-15");
  assert.equal(advanced.actualPayday, "2026-12-15");
});

test("unavailable payday never falls back to a known rest day and the 366-day search is bounded", () => {
  const { settings } = fixture();
  settings.publicHolidays = false;
  settings.payroll.payDay = 1;
  settings.payroll.payMonthOffset = 0;
  settings.payroll.holidayAdjustment = "next";
  for (let day = 0; day <= 366; day++)
    settings.overrides[dateKey(new Date(2026, 10, 1 + day))] = "rest";
  const unavailable = getPayrollPeriod("2026-11-10", settings);
  assert.equal(unavailable.actualPayday, null);
  assert.equal(unavailable.adjustmentDays, 0);
  settings.overrides["2027-11-02"] = "work";
  const lastDay = getPayrollPeriod("2026-11-10", settings);
  assert.equal(lastDay.actualPayday, "2027-11-02");
  assert.equal(lastDay.adjustmentDays, 366);
});

test("coverage warns about unlisted period and adjustment years but stays complete with holidays disabled", () => {
  const { settings } = fixture();
  assert.equal(
    getPayrollPeriod("2027-12-10", settings).holidayCoverageComplete,
    false,
  );
  assert.equal(
    getPayrollPeriod("2026-11-10", settings).holidayCoverageComplete,
    true,
  );
  settings.payroll.payDay = 1;
  settings.payroll.payMonthOffset = 0;
  settings.payroll.holidayAdjustment = "previous";
  assert.equal(
    getPayrollPeriod("2026-01-10", settings).actualPayday,
    "2025-12-31",
  );
  assert.equal(
    getPayrollPeriod("2026-01-10", settings).holidayCoverageComplete,
    false,
  );
  settings.publicHolidays = false;
  assert.equal(
    getPayrollPeriod("2028-01-10", settings).holidayCoverageComplete,
    true,
  );
});

test("payroll settings migrate safely, validate input, and preserve both old and new record rates", () => {
  const defaults = normalizeSettings({}).payroll;
  assert.deepEqual(defaults, {
    cycleStartDay: 1,
    payDay: 15,
    payMonthOffset: 1,
    holidayAdjustment: "previous",
  });
  assert.deepEqual(
    normalizeSettings({
      payroll: {
        cycleStartDay: 0,
        payDay: NaN,
        payMonthOffset: 3,
        holidayAdjustment: "invalid",
      },
    }).payroll,
    defaults,
  );
  const { settings } = fixture();
  settings.payroll = {
    cycleStartDay: 26,
    payDay: 31,
    payMonthOffset: 2,
    holidayAdjustment: "next",
  };
  assert.deepEqual(normalizeSettings(settings).payroll, settings.payroll);
  assert.deepEqual(validateSettings(settings), []);
  settings.payroll.cycleStartDay = 1.5;
  assert.match(validateSettings(settings).join(" "), /周期起始日/);
  settings.payroll.cycleStartDay = 26;
  settings.payroll.payDay = 0;
  assert.match(validateSettings(settings).join(" "), /发薪日请选择/);
  let data = startWork(fixture(), time("2026-11-10", "09:00"));
  data = pauseWork(data, time("2026-11-10", "10:00"));
  const original = data.records["2026-11-10"].plan;
  const legacy = JSON.parse(JSON.stringify(data));
  delete legacy.settings.payroll;
  delete legacy.records["2026-11-10"].plan.periodStart;
  delete legacy.records["2026-11-10"].plan.periodEnd;
  legacy.settings.payroll = { ...defaults, cycleStartDay: 26 };
  const restored = normalizeData(legacy);
  assert.equal(restored.records["2026-11-10"].plan.periodStart, "2026-11-01");
  assert.equal(restored.records["2026-11-10"].plan.periodEnd, "2026-11-30");
  assert.equal(
    restored.records["2026-11-10"].plan.perSecond,
    original.perSecond,
  );
  assert.equal(restored.records["2026-11-10"].plan.workdays, 21);
  assert.equal(getDayPlan("2026-11-11", restored.settings).workdays, 23);
  const newRecord = startWork(restored, time("2026-11-11", "09:00"));
  newRecord.settings.payroll.cycleStartDay = 1;
  const disk = normalizeData(JSON.parse(JSON.stringify(newRecord)));
  assert.equal(disk.records["2026-11-11"].plan.periodStart, "2026-10-26");
  assert.equal(disk.records["2026-11-11"].plan.periodEnd, "2026-11-25");
  assert.equal(disk.records["2026-11-11"].plan.workdays, 23);
});

test("period earnings include both ends across months without repricing history or including neighbours", () => {
  let data = fixture();
  data.settings.payroll.cycleStartDay = 26;
  for (const day of ["2026-10-23", "2026-10-30", "2026-11-02", "2026-11-26"]) {
    data = startWork(data, time(day, "09:00"));
    data = pauseWork(data, time(day, "10:00"));
  }
  const expected =
    data.records["2026-10-30"].plan.perSecond * 3600 +
    data.records["2026-11-02"].plan.perSecond * 3600;
  data.settings.monthlySalary = 99999;
  assert.equal(
    periodEarnings(
      data,
      "2026-10-26",
      "2026-11-25",
      time("2026-11-27", "10:00"),
    ),
    expected,
  );
  assert.equal(
    periodEarnings(
      data,
      "2026-10-30",
      "2026-11-02",
      time("2026-11-27", "10:00"),
    ),
    expected,
  );
  assert.equal(periodEarnings(data, "2026-11-25", "2026-10-26"), 0);
});

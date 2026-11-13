import assert from "node:assert/strict";
import test from "node:test";
import { emptyData, startWork, pauseWork, finishWork, getRecordSummary, type AppData } from "../src/core";
import { createDataBackup, parseDataBackup, prepareBackupForImport, normalizeBackupHistory, summarizeBackup, MAX_BACKUP_BYTES } from "./data-backup-policy";
import type { BiliHistoryEntry } from "../src/bilibili-history-types";

const day = "2026-11-10";
const at = (clock: string) => new Date(`${day}T${clock}:00`).getTime();
const clone = <T>(value: T): T => structuredClone(value);
function data(): AppData {
  const value = emptyData();
  value.settings.alternateAnchor = "2026-11-09";
  value.settings.publicHolidays = false;
  return startWork(value, at("09:30"));
}
const history = (): BiliHistoryEntry => ({ bvid: "BV17x411w7KC", title: "一段视频", owner: "作者", duration: 123,
  lastSearchedAt: at("09:00"), lastPlayedAt: at("10:00"), lastMode: "audio", lastCid: 101 });
const backup = () => createDataBackup({ data: data(), appVersion: "1.5.3", history: [history()],
  preferences: { bossShortcut: "CommandOrControl+Alt+B", floating: { enabled: true, expanded: false, privacy: true } } }, at("10:30"));
const rejects = (value: unknown) => assert.throws(() => parseDataBackup(JSON.stringify(value)), /备份|记录/);

test("export captures active seconds without changing live work and import never resumes the clock", () => {
  const live = data(), before = clone(live);
  const snapshot = createDataBackup({ data: live, appVersion: "1.5.3" }, at("10:30"));
  assert.deepEqual(live, before);
  assert.equal(live.records[day].intervals[0].to, null);
  assert.equal(snapshot.data.records[day].intervals[0].to, at("10:30"));
  const parsed = parseDataBackup(JSON.stringify(snapshot), at("15:00"));
  const imported = prepareBackupForImport(parsed, at("15:00"));
  const expected = getRecordSummary(live, day, at("10:30"));
  const restored = getRecordSummary(imported.data, day, at("15:00"));
  assert.equal(restored.status, "paused");
  assert.equal(restored.seconds, expected.seconds);
  assert.equal(restored.earnings, expected.earnings);
  assert.equal(imported.data.records[day].intervals.some(interval => interval.to === null), false);
  imported.data.settings.monthlySalary = 1;
  assert.notEqual(live.settings.monthlySalary, 1);
});

test("completed wage targets and record snapshots survive salary edits and later imports", () => {
  const completed = finishWork(data(), at("10:30"));
  const earned = getRecordSummary(completed, day, at("10:30"));
  completed.settings.monthlySalary = 123456;
  const imported = prepareBackupForImport(parseDataBackup(JSON.stringify(createDataBackup({ data: completed, appVersion: "1.5.3" }, at("11:00")))), at("17:00"));
  const actual = getRecordSummary(imported.data, day, at("17:00"));
  assert.equal(actual.earnings, earned.earnings);
  assert.equal(actual.dailyWage, earned.dailyWage);
  assert.equal(actual.seconds, earned.seconds);
  assert.equal(actual.status, "completed");
});

test("a legacy state is identified and safely pauses unknown open intervals without invented offline work", () => {
  const old = clone(data()) as unknown as Record<string, any>;
  for (const key of ["dinner", "publicHolidays", "payroll", "doubleRestDays"]) delete old.settings[key];
  for (const key of ["dinnerStart", "dinnerEnd", "periodStart", "periodEnd"]) delete old.records[day].plan[key];
  const parsed = parseDataBackup(JSON.stringify(old), at("15:00"));
  assert.equal(parsed.source, "legacy");
  assert.equal(parsed.exportedAt, null);
  assert.equal(parsed.appVersion, null);
  assert.deepEqual(parsed.data.records[day].intervals, [{ from: at("09:30"), to: at("09:30") }]);
  assert.equal(getRecordSummary(parsed.data, day, at("15:00")).seconds, 0);
  assert.equal(parsed.history, undefined);
  assert.equal(parsed.preferences, undefined);
  assert.equal(summarizeBackup(parsed).legacy, true);
});

test("exports whitelist portable facts and never include credentials, stream URLs, cache or window positions", () => {
  const input = data() as AppData & { credentials: string };
  input.credentials = "TOP_SECRET_COOKIE";
  (input.settings as any).gitToken = "TOP_SECRET_GIT";
  const h = { ...history(), audioUrl: "https://example.invalid/TOP_SECRET_STREAM" };
  const preferences = { bossShortcut: "Ctrl+Alt+B", floating: { enabled: true, expanded: true, privacy: false, position: { x: 55, y: 66 } }, login: "TOP_SECRET_LOGIN" };
  const snapshot = createDataBackup({ data: input, appVersion: "1.5.3", history: [h], preferences }, at("10:30"));
  assert.doesNotMatch(JSON.stringify(snapshot), /TOP_SECRET|credentials|gitToken|audioUrl|position/);
  assert.equal(snapshot.preferences!.bossShortcut, "Control+Alt+B");
  const summary = summarizeBackup(snapshot);
  assert.deepEqual(summary, { exportedAt: new Date(at("10:30")).toISOString(), appVersion: "1.5.3", legacy: false,
    workdayCount: 1, historyCount: 1, hasHistory: true, hasPreferences: true });
});

test("malformed settings, future formats and invalid timestamps are rejected instead of defaulted", () => {
  for (const input of [null, {}, { version: 1, settings: {}, records: {} }, [], { ...backup(), version: 2 },
    { ...backup(), format: "other-application" }, { ...backup(), exportedAt: "2026-02-30T12:00:00.000Z" },
    { ...backup(), exportedAt: null }, { ...backup(), appVersion: null }]) rejects(input);
  for (const mutate of [
    (value: any) => { value.data.settings.monthlySalary = "15000"; },
    (value: any) => { value.data.settings.weekdayHours[2].end = "25:00"; },
    (value: any) => { value.data.settings.payroll.payDay = 32; },
    (value: any) => { value.data.settings.overrides["2026-02-30"] = "rest"; },
    (value: any) => { delete value.data.settings.dinner; },
  ]) { const value = backup(); mutate(value); rejects(value); }
});

test("bad or incompatible work rows are never silently removed or repriced by normalization", () => {
  for (const mutate of [
    (value: any) => { value.data.records.bad = value.data.records[day]; },
    (value: any) => { value.data.records[day].date = "2026-11-11"; },
    (value: any) => { value.data.records[day].plan.end = value.data.records[day].plan.start; },
    (value: any) => { value.data.records[day].intervals[0].to = at("08:00"); },
    (value: any) => { value.data.records[day].intervals.push({ from: at("11:00"), to: null }, { from: at("11:30"), to: null }); },
    (value: any) => { value.data.records[day].plan.dailyWage = -1; },
    (value: any) => { value.data.records[day].plan.plannedSeconds += 1; },
    (value: any) => { value.data.records[day].plan.perSecond = 999; },
    (value: any) => { value.data.records[day].plan.periodStart = "2026-09-01"; },
    (value: any) => { const p = value.data.records[day].plan; p.start -= 86400000; p.end -= 86400000; value.data.records[day].intervals[0].from -= 86400000; value.data.records[day].intervals[0].to -= 86400000; },
  ]) { const value = backup(); mutate(value); rejects(value); }
});

test("history validates dates and modes, merges duplicate BV facts, and keeps independent snapshots", () => {
  const first = history();
  const newer = { ...history(), title: "新标题", lastSearchedAt: at("11:00"), lastPlayedAt: null, lastMode: null, lastCid: null };
  const merged = normalizeBackupHistory([first, newer]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, "新标题");
  assert.equal(merged[0].lastMode, "audio");
  assert.equal(merged[0].lastPlayedAt, first.lastPlayedAt);
  merged[0].title = "mutation";
  assert.equal(newer.title, "新标题");
  for (const patch of [{ bvid: "invalid" }, { lastPlayedAt: -1 }, { lastMode: "playlist" }, { lastCid: 0 }, { lastSearchedAt: null, lastPlayedAt: null }, { title: "x".repeat(161) }])
    assert.throws(() => normalizeBackupHistory([{ ...history(), ...patch }]), /备份/);
});

test("invalid preference shortcuts or booleans are rejected before applying settings", () => {
  for (const preferences of [{ bossShortcut: "a" }, { bossShortcut: "Ctrl+constructor" }, { floating: { enabled: true, expanded: false, privacy: "false" } }, { floating: null }])
    rejects({ ...backup(), preferences });
});

test("UTF-8 file, app data and history size limits reject oversized input without mutation", () => {
  assert.throws(() => parseDataBackup(" ".repeat(MAX_BACKUP_BYTES + 1)), /过大/);
  const value = backup();
  (value.data as any).unknown = "x".repeat(4 * 1024 * 1024);
  rejects(value);
  assert.throws(() => normalizeBackupHistory([{ ...history(), unknown: "x".repeat(8 * 1024 * 1024) }]), /备份/);
  assert.throws(() => parseDataBackup("not json"), /JSON/);
});

test("known exported intervals are capped at the snapshot, while existing closed facts and future clock rollback are kept", () => {
  const value = backup();
  value.data.records[day].intervals[0].to = null;
  const parsed = parseDataBackup(JSON.stringify(value), at("15:00"));
  assert.equal(parsed.data.records[day].intervals[0].to, at("10:30"));
  const paused = pauseWork(data(), at("10:00"));
  const clockRollback = createDataBackup({ data: paused, appVersion: "1.5.3" }, at("09:45"));
  assert.equal(clockRollback.data.records[day].intervals[0].to, at("10:00"));
  const futureOpen = createDataBackup({ data: data(), appVersion: "1.5.3" }, at("09:00"));
  assert.equal(futureOpen.data.records[day].intervals[0].to, at("09:30"));
  assert.equal(data().records[day].intervals[0].to, null);
});

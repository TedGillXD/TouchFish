import { normalizeData, validateSettings, dateKey, type AppData } from "../src/core";
import type { BiliHistoryEntry } from "../src/bilibili-history-types";
import { normalizeBvid } from "./bilibili-policy";
import { normalizeBossShortcut } from "./boss-key";

export const MAX_BACKUP_BYTES = 16 * 1024 * 1024;
const MAX_DATA_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
export interface BackupPreferences {
  bossShortcut?: string;
  floating?: { enabled: boolean; expanded: boolean; privacy: boolean };
}
/** Null metadata and source only describe an imported legacy state.json. */
export interface DataBackup {
  format: "touchfish-backup";
  version: 1;
  exportedAt: string | null;
  appVersion: string | null;
  data: AppData;
  history?: BiliHistoryEntry[];
  preferences?: BackupPreferences;
  source?: "legacy";
}
export interface BackupInput {
  data: AppData;
  appVersion: string;
  history?: BiliHistoryEntry[];
  preferences?: BackupPreferences;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const epoch = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
const clock = (value: unknown): value is string => typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const day = (value: unknown): value is string => typeof value === "string" && /^(?:19|20|21|22)\d{2}-\d{2}-\d{2}$/.test(value) && dateKey(new Date(`${value}T12:00:00`)) === value;
const weekday = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 6;
const monthDay = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 31;
const version = (value: unknown): value is string => typeof value === "string" && value.length <= 100 && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value);
const invalid = () => new Error("备份数据格式不正确或不完整，未修改本地数据。");
const invalidRecord = () => new Error("备份中的工作记录无法完整读取，请检查文件和设备时区；未修改本地数据。");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const closeEnough = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-8, Math.abs(a) * 1e-12);

function settingsShape(value: unknown, legacy: boolean) {
  if (!object(value) || !finite(value.monthlySalary) || value.monthlySalary < 0 || value.monthlySalary > 1e9 ||
    typeof value.scheduleMode !== "string" || !["double", "single", "alternate"].includes(value.scheduleMode) || !weekday(value.restDay) || !day(value.alternateAnchor) ||
    !object(value.weekdayHours) || !object(value.lunch) || !object(value.overrides)) throw invalid();
  if (value.doubleRestDays === undefined ? !legacy : !Array.isArray(value.doubleRestDays) || value.doubleRestDays.length !== 2 ||
    !weekday(value.doubleRestDays[0]) || !weekday(value.doubleRestDays[1]) || value.doubleRestDays[0] === value.doubleRestDays[1]) throw invalid();
  if (value.publicHolidays === undefined ? !legacy : typeof value.publicHolidays !== "boolean") throw invalid();
  for (let index = 0; index < 7; index++) {
    const hours = value.weekdayHours[index];
    if (!object(hours) || !clock(hours.start) || !clock(hours.end) || hours.start >= hours.end) throw invalid();
  }
  for (const key of ["lunch", "dinner"]) {
    const meal = value[key];
    if (key === "dinner" && meal === undefined && legacy) continue;
    if (!object(meal) || typeof meal.enabled !== "boolean" || !clock(meal.start) || !clock(meal.end) || meal.start >= meal.end) throw invalid();
  }
  const payroll = value.payroll;
  if (!(legacy && payroll === undefined) && (!object(payroll) || !monthDay(payroll.cycleStartDay) || !monthDay(payroll.payDay) ||
    ![0, 1, 2].includes(Number(payroll.payMonthOffset)) || typeof payroll.payMonthOffset !== "number" ||
    typeof payroll.holidayAdjustment !== "string" || !["previous", "next", "none"].includes(payroll.holidayAdjustment))) throw invalid();
  for (const [key, kind] of Object.entries(value.overrides)) if (!day(key) || kind !== "work" && kind !== "rest") throw invalid();
}

/** Reject invalid rows before the application's permissive storage migration. */
function appData(value: unknown, legacy: boolean): AppData {
  if (!object(value) || value.version !== 1 || !object(value.records) || bytes(value) > MAX_DATA_BYTES) throw invalid();
  settingsShape(value.settings, legacy);
  const rows = Object.entries(value.records);
  if (rows.length > 10000) throw invalidRecord();
  for (const [key, raw] of rows) {
    if (!day(key) || !object(raw) || raw.date !== key || !object(raw.plan) || !Array.isArray(raw.intervals) ||
      !raw.intervals.length || raw.intervals.length > 10000 || typeof raw.completed !== "boolean" ||
      raw.accrualVersion !== undefined && raw.accrualVersion !== 2) throw invalidRecord();
    const p = raw.plan;
    if (p.working !== true || !epoch(p.start) || !epoch(p.end) || p.start >= p.end ||
      !finite(p.dailyWage) || p.dailyWage < 0 || p.dailyWage > 1e9 || !Number.isInteger(p.workdays) ||
      Number(p.workdays) < 1 || Number(p.workdays) > 31 || !finite(p.plannedSeconds) || p.plannedSeconds < 0 ||
      !finite(p.perSecond) || p.perSecond < 0) throw invalidRecord();
    for (const [start, end] of [["breakStart", "breakEnd"], ["dinnerStart", "dinnerEnd"]]) {
      if (legacy && p[start] === undefined && p[end] === undefined) continue;
      if (p[start] === null && p[end] === null) continue;
      if (!epoch(p[start]) || !epoch(p[end]) || p[start] >= p[end]) throw invalidRecord();
    }
    if (!(legacy && p.periodStart === undefined && p.periodEnd === undefined) &&
      (!day(p.periodStart) || !day(p.periodEnd) || p.periodStart > key || p.periodEnd < key ||
        Date.parse(`${p.periodEnd}T00:00:00Z`) - Date.parse(`${p.periodStart}T00:00:00Z`) >= 31 * 86_400_000)) throw invalidRecord();
    let opens = 0;
    for (const range of raw.intervals) {
      if (!object(range) || !epoch(range.from) || range.from < p.start || range.from >= p.end ||
        range.to !== null && (!epoch(range.to) || range.to < range.from || range.to > p.end)) throw invalidRecord();
      if (range.to === null && (++opens > 1 || raw.completed)) throw invalidRecord();
    }
  }
  const normalized = normalizeData(value);
  if (validateSettings(normalized.settings).length || Object.keys(normalized.records).length !== rows.length) throw invalidRecord();
  for (const [key, raw] of rows) {
    const row = raw as Record<string, unknown>, p = row.plan as Record<string, number>;
    const restored = normalized.records[key];
    if (!restored || restored.intervals.length !== (row.intervals as unknown[]).length ||
      restored.plan.start !== p.start || restored.plan.end !== p.end || restored.plan.dailyWage !== p.dailyWage || restored.plan.workdays !== p.workdays ||
      !legacy && (!closeEnough(restored.plan.plannedSeconds, p.plannedSeconds) || !closeEnough(restored.plan.perSecond, p.perSecond))) throw invalidRecord();
  }
  return normalized;
}

export function normalizeBackupHistory(value: unknown): BiliHistoryEntry[] {
  if (!Array.isArray(value) || bytes(value) > MAX_HISTORY_BYTES) throw invalid();
  const entries = new Map<string, BiliHistoryEntry>();
  for (const raw of value) {
    if (!object(raw) || typeof raw.bvid !== "string" || !/^BV1[A-Za-z0-9]{9}$/i.test(raw.bvid) ||
      typeof raw.title !== "string" || raw.title.length > 160 || typeof raw.owner !== "string" || raw.owner.length > 80 ||
      !finite(raw.duration) || raw.duration < 0 || raw.duration > 604800 ||
      raw.lastSearchedAt !== null && (!epoch(raw.lastSearchedAt) || raw.lastSearchedAt < 0) ||
      raw.lastPlayedAt !== null && (!epoch(raw.lastPlayedAt) || raw.lastPlayedAt < 0) ||
      raw.lastSearchedAt === null && raw.lastPlayedAt === null ||
      raw.lastMode !== null && raw.lastMode !== "audio" && raw.lastMode !== "video" ||
      raw.lastCid !== null && (!Number.isSafeInteger(raw.lastCid) || Number(raw.lastCid) <= 0) ||
      raw.lastPlayedAt !== null && (raw.lastMode === null || raw.lastCid === null)) throw invalid();
    const bvid = normalizeBvid(raw.bvid);
    const next: BiliHistoryEntry = { bvid, title: raw.title.replace(/[\u0000-\u001f\u007f]/g, " "), owner: raw.owner.replace(/[\u0000-\u001f\u007f]/g, " "),
      duration: raw.duration, lastSearchedAt: raw.lastSearchedAt as number | null, lastPlayedAt: raw.lastPlayedAt as number | null,
      lastMode: raw.lastPlayedAt === null ? null : raw.lastMode as "audio" | "video", lastCid: raw.lastPlayedAt === null ? null : Number(raw.lastCid) };
    const previous = entries.get(bvid);
    if (!previous) entries.set(bvid, next);
    else {
      const recent = (entry: BiliHistoryEntry) => Math.max(entry.lastSearchedAt ?? -1, entry.lastPlayedAt ?? -1);
      const newest = recent(next) > recent(previous) ? next : previous;
      const played = (next.lastPlayedAt ?? -1) > (previous.lastPlayedAt ?? -1) ? next : previous;
      entries.set(bvid, { ...newest, lastSearchedAt: previous.lastSearchedAt === null && next.lastSearchedAt === null ? null : Math.max(previous.lastSearchedAt ?? 0, next.lastSearchedAt ?? 0),
        lastPlayedAt: played.lastPlayedAt, lastMode: played.lastMode, lastCid: played.lastCid });
    }
  }
  return [...entries.values()].sort((a, b) => Math.max(b.lastPlayedAt ?? 0, b.lastSearchedAt ?? 0) - Math.max(a.lastPlayedAt ?? 0, a.lastSearchedAt ?? 0));
}

function preferences(value: unknown): BackupPreferences {
  if (!object(value)) throw invalid();
  const output: BackupPreferences = {};
  if (value.bossShortcut !== undefined) {
    try { output.bossShortcut = normalizeBossShortcut(value.bossShortcut); }
    catch { throw new Error("备份中的老板键快捷键无法识别，未修改本地数据。"); }
  }
  if (value.floating !== undefined) {
    const p = value.floating;
    if (!object(p) || typeof p.enabled !== "boolean" || typeof p.expanded !== "boolean" || typeof p.privacy !== "boolean") throw invalid();
    output.floating = { enabled: p.enabled, expanded: p.expanded, privacy: p.privacy };
  }
  return output;
}

function capture(data: AppData, cutoff: number | null): AppData {
  return { ...data, records: Object.fromEntries(Object.entries(data.records).map(([key, row]) => [key, { ...row,
    plan: { ...row.plan }, intervals: row.intervals.map(range => ({ from: range.from,
      to: range.to ?? (cutoff === null ? range.from : Math.max(range.from, Math.min(row.plan.end, cutoff))) })),
  }])) };
}
function sizeGuard(backup: DataBackup) {
  if (bytes(backup) > MAX_BACKUP_BYTES) throw new Error("备份文件过大，未修改本地数据。");
  return backup;
}
const snapshotTime = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && day(value.slice(0, 10)) && Number.isFinite(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value);

export function createDataBackup(input: BackupInput, now = Date.now()): DataBackup {
  if (!epoch(now) || !version(input.appVersion)) throw invalid();
  const data = capture(appData(input.data, false), now);
  return sizeGuard({ format: "touchfish-backup", version: 1, exportedAt: new Date(now).toISOString(), appVersion: input.appVersion, data,
    ...(input.history !== undefined ? { history: normalizeBackupHistory(input.history) } : {}),
    ...(input.preferences !== undefined ? { preferences: preferences(input.preferences) } : {}),
  });
}

export function parseDataBackup(text: string, _now = Date.now()): DataBackup {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_BACKUP_BYTES) throw new Error("备份文件过大或无法读取，未修改本地数据。");
  let raw: unknown;
  try { raw = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { throw new Error("备份文件不是有效的 JSON，未修改本地数据。"); }
  if (!object(raw)) throw invalid();
  if (raw.format === undefined && raw.version === 1 && object(raw.settings) && object(raw.records)) {
    return { format: "touchfish-backup", version: 1, exportedAt: null, appVersion: null, source: "legacy", data: capture(appData(raw, true), null) };
  }
  if (raw.format !== "touchfish-backup") throw invalid();
  if (raw.version !== 1) throw new Error("此备份版本暂不支持，请升级应用后重试；未修改本地数据。");
  if (!snapshotTime(raw.exportedAt) || !version(raw.appVersion)) throw invalid();
  return sizeGuard({ format: "touchfish-backup", version: 1, exportedAt: raw.exportedAt, appVersion: raw.appVersion,
    data: capture(appData(raw.data, false), Date.parse(raw.exportedAt)),
    ...(raw.history !== undefined ? { history: normalizeBackupHistory(raw.history) } : {}),
    ...(raw.preferences !== undefined ? { preferences: preferences(raw.preferences) } : {}),
  });
}

export function prepareBackupForImport(backup: DataBackup, _now = Date.now()): DataBackup {
  if (backup.source === "legacy" && backup.exportedAt === null && backup.appVersion === null)
    return { format: "touchfish-backup", version: 1, source: "legacy", exportedAt: null, appVersion: null, data: capture(appData(backup.data, true), null) };
  return parseDataBackup(JSON.stringify(backup));
}

export function summarizeBackup(backup: DataBackup) {
  return { exportedAt: backup.exportedAt, appVersion: backup.appVersion, legacy: backup.source === "legacy",
    workdayCount: Object.keys(backup.data.records).length, historyCount: backup.history?.length ?? 0,
    hasHistory: backup.history !== undefined, hasPreferences: !!backup.preferences && Object.keys(backup.preferences).length > 0 };
}

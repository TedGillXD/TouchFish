import assert from "node:assert/strict";
import test from "node:test";
import {
  closeOvertime,
  deleteOvertime,
  emptyOvertime,
  getActiveOvertime,
  getOvertimeTotals,
  overtimePay,
  overtimeSeconds,
  parseOvertime,
  reconcileOvertime,
  saveOvertime,
  setOvertimeBase,
  startOvertime,
  type OvertimeInput,
} from "./overtime";

const noon = new Date(2026, 10, 18, 12).getTime();
const input: OvertimeInput = {
  date: "2026-11-18", kind: "weekday", monthlyBase: 17400, seconds: 3600, compensatedSeconds: 0,
};

test("overtime uses the 21.75-day and eight-hour wage conversion for each type", () => {
  let data = saveOvertime(emptyOvertime(), input, noon);
  data = saveOvertime(data, { ...input, kind: "rest", compensatedSeconds: 900 }, noon);
  data = saveOvertime(data, { ...input, kind: "statutory" }, noon);
  assert.deepEqual(data.entries.map(entry => overtimePay(entry, noon)), [300, 150, 150]);
  assert.deepEqual(getOvertimeTotals(data, "2026-11-01", input.date, noon), { seconds: 10800, earnings: 600 });
  assert.deepEqual(getOvertimeTotals(data, "2026-11-19", "2026-11-30", noon), { seconds: 0, earnings: 0 });
  assert.deepEqual(getOvertimeTotals(undefined, "2026-11-01", input.date, noon), { seconds: 0, earnings: 0 });
  assert.throws(() => saveOvertime(data, { ...input, kind: "statutory", compensatedSeconds: 1 }, noon), /仅休息日/);
  assert.throws(() => saveOvertime(data, { ...input, kind: "rest", compensatedSeconds: 3601 }, noon), /超过加班时长/);
});

test("past records keep their wage base and can record compensatory rest later", () => {
  const original = saveOvertime(emptyOvertime(), { ...input, kind: "rest" }, noon);
  const configured = setOvertimeBase(original, 20900);
  assert.equal(overtimePay(configured.entries[0], noon), 200);
  const updated = saveOvertime(configured, { ...configured.entries[0], compensatedSeconds: 3600 }, noon, configured.entries[0].id);
  assert.equal(overtimePay(updated.entries[0], noon), 0);
  assert.equal(updated.entries[0].monthlyBase, 17400);
  assert.equal(overtimePay(original.entries[0], noon), 200);
  assert.deepEqual(deleteOvertime(updated, updated.entries[0].id).entries, []);
});

test("the timer keeps actual elapsed seconds and stops at the local date boundary", () => {
  const start = new Date(2026, 10, 18, 23, 59, 15).getTime();
  const midnight = new Date(2026, 10, 19).getTime();
  const live = startOvertime(emptyOvertime(), input, start);
  const entry = getActiveOvertime(live)!;
  assert.equal(entry.date, input.date);
  assert.equal(entry.endsAt, midnight);
  assert.equal(overtimeSeconds(entry, start - 1000), 0);
  assert.equal(overtimeSeconds(entry, start + 1500), 1);
  assert.equal(overtimePay(entry, start + 1500), 150 / 3600);
  assert.throws(() => startOvertime(live, input, start + 1000), /先结束/);
  assert.throws(() => deleteOvertime(live, entry.id), /先结束/);
  assert.throws(() => saveOvertime(live, input, start + 1000, entry.id), /先结束/);
  assert.deepEqual(closeOvertime(live, start + 100).entries, []);
  const settled = reconcileOvertime(live, midnight + 7200000);
  assert.equal(getActiveOvertime(settled), undefined);
  assert.equal(settled.entries[0].seconds, 45);
  assert.equal(settled.entries[0].date, input.date);
});

test("timed and manual entries share the daily recording limit without backfilling", () => {
  const manual = saveOvertime(emptyOvertime(), { ...input, seconds: 86390 }, noon);
  const live = startOvertime(manual, input, noon);
  assert.equal(getActiveOvertime(live)?.endsAt, noon + 10000);
  assert.throws(() => saveOvertime(live, { ...input, seconds: 1 }, noon), /合计/);
  const stopped = closeOvertime(live, noon + 1000);
  assert.equal(stopped.entries[0].seconds, 1);
  assert.equal(getOvertimeTotals(stopped, input.date, input.date, noon).seconds, 86391);
  assert.doesNotThrow(() => saveOvertime(stopped, { ...input, seconds: 9 }, noon));
  assert.throws(() => saveOvertime(stopped, { ...input, date: "2026-11-19" }, noon), /今天或更早/);
});

test("overtime backup validation preserves legitimate records and rejects malformed snapshots", () => {
  const saved = saveOvertime(emptyOvertime(), input, noon);
  const current = startOvertime(saved, input, noon);
  assert.deepEqual(parseOvertime(undefined), emptyOvertime());
  assert.deepEqual(parseOvertime(JSON.parse(JSON.stringify(current))), current);
  const [live, row] = current.entries;
  for (const entries of [
    [row, row],
    [live, { ...live, id: "other-timer" }],
    [{ ...row, date: "2026-02-30" }],
    [{ ...row, kind: "__proto__" }],
    [{ ...row, monthlyBase: Infinity }],
    [{ ...row, compensatedSeconds: 60 }],
    [{ ...row, startedAt: noon }],
    [{ ...live, endsAt: noon + 86400001 }],
    [{ ...row, seconds: 86400 }, { ...row, id: "extra" }],
  ]) assert.throws(() => parseOvertime({ monthlyBase: null, entries }), /加班数据格式/);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  getPublicHoliday,
  PUBLIC_HOLIDAY_SOURCES,
  PUBLIC_HOLIDAY_YEARS,
} from "./holidays";

function listedDays(year: number, kind: "rest" | "work"): string[] {
  const result: string[] = [];
  const end = Date.UTC(year + 1, 0, 1);
  for (let value = Date.UTC(year, 0, 1); value < end; value += 86_400_000) {
    const key = new Date(value).toISOString().slice(0, 10);
    if (getPublicHoliday(key)?.kind === kind) result.push(key);
  }
  return result;
}

test("2026 published vacation ranges and all six makeup days are exact", () => {
  assert.equal(listedDays(2026, "rest").length, 33);
  assert.deepEqual(listedDays(2026, "work"), [
    "2026-01-04",
    "2026-02-14",
    "2026-02-28",
    "2026-05-09",
    "2026-09-20",
    "2026-10-10",
  ]);
  const expected = [
    ["2026-01-01", "2026-01-03", "元旦"],
    ["2026-02-15", "2026-02-23", "春节"],
    ["2026-04-04", "2026-04-06", "清明节"],
    ["2026-05-01", "2026-05-05", "劳动节"],
    ["2026-06-19", "2026-06-21", "端午节"],
    ["2026-09-25", "2026-09-27", "中秋节"],
    ["2026-10-01", "2026-10-07", "国庆节"],
  ];
  for (const [first, last, name] of expected) {
    for (
      let date = Date.parse(`${first}T00:00:00Z`);
      date <= Date.parse(`${last}T00:00:00Z`);
      date += 86_400_000
    ) {
      assert.deepEqual(
        getPublicHoliday(new Date(date).toISOString().slice(0, 10)),
        { kind: "rest", name },
      );
    }
  }
  assert.equal(getPublicHoliday("2026-02-24"), null);
  assert.equal(getPublicHoliday("2026-10-08"), null);
});

test("2027 published calendar has both cross-month makeup pairs and single-day festivals", () => {
  assert.equal(listedDays(2027, "rest").length, 29);
  assert.deepEqual(listedDays(2027, "work"), [
    "2027-01-31",
    "2027-02-14",
    "2027-05-08",
    "2027-09-26",
    "2027-10-09",
  ]);
  for (let day = 5; day <= 13; day++) {
    assert.deepEqual(
      getPublicHoliday(`2027-02-${String(day).padStart(2, "0")}`),
      { kind: "rest", name: "春节" },
    );
  }
  for (let day = 1; day <= 7; day++) {
    assert.deepEqual(getPublicHoliday(`2027-10-0${day}`), {
      kind: "rest",
      name: "国庆节",
    });
  }
  assert.deepEqual(getPublicHoliday("2027-06-09"), {
    kind: "rest",
    name: "端午节",
  });
  assert.equal(getPublicHoliday("2027-06-08"), null);
  assert.equal(getPublicHoliday("2027-06-10"), null);
  assert.deepEqual(getPublicHoliday("2027-09-15"), {
    kind: "rest",
    name: "中秋节",
  });
  assert.equal(getPublicHoliday("2027-09-14"), null);
  assert.equal(getPublicHoliday("2027-09-16"), null);
});

test("calendar explicitly limits coverage and does not invent unannounced dates", () => {
  assert.deepEqual(PUBLIC_HOLIDAY_YEARS, [2026, 2027]);
  assert.deepEqual(
    PUBLIC_HOLIDAY_SOURCES.map((source) => source.year),
    PUBLIC_HOLIDAY_YEARS,
  );
  for (const source of PUBLIC_HOLIDAY_SOURCES) {
    assert.equal(new URL(source.url).protocol, "https:");
    assert.match(source.title, new RegExp(String(source.year)));
  }
  for (const key of [
    "2025-10-01",
    "2028-01-01",
    "2026-02-30",
    "2026-1-1",
    "",
    "invalid",
  ]) {
    assert.equal(getPublicHoliday(key), null);
  }
});

test("callers cannot mutate the embedded official calendar", () => {
  const day = getPublicHoliday("2026-10-01")!;
  day.kind = "work";
  assert.deepEqual(getPublicHoliday("2026-10-01"), {
    kind: "rest",
    name: "国庆节",
  });
});

/**
 * Published mainland China public-holiday arrangements, available offline.
 * These ranges include the complete announced vacation, including weekends,
 * and the corresponding makeup workdays. Unlisted years are not inferred.
 */
export interface PublicHoliday {
  kind: "rest" | "work";
  name: string;
}

export const PUBLIC_HOLIDAY_YEARS: readonly number[] = Object.freeze([
  2026, 2027,
]);

export const PUBLIC_HOLIDAY_SOURCES = Object.freeze([
  {
    year: 2026,
    title: "国务院办公厅关于2026年部分节假日安排的通知",
    url: "https://www.beijing.gov.cn/zhengce/zhengcefagui/202511/t20251104_4258873.html",
  },
  {
    year: 2027,
    title: "国务院办公厅关于2027年部分节假日安排的通知",
    url: "https://chinajob.mohrss.gov.cn/h5/c/2026-11-09/635850.shtml",
  },
] as const);

const calendar = new Map<string, Readonly<PublicHoliday>>();
const DAY_MS = 86_400_000;

// Use UTC calendar arithmetic, so DST or the host timezone cannot move a date.
function addVacation(name: string, start: string, end: string): void {
  const first = Date.parse(`${start}T00:00:00Z`);
  const last = Date.parse(`${end}T00:00:00Z`);
  for (let day = first; day <= last; day += DAY_MS) {
    const key = new Date(day).toISOString().slice(0, 10);
    if (calendar.has(key)) throw new Error(`节假日日期重复：${key}`);
    calendar.set(key, Object.freeze({ kind: "rest", name }));
  }
}

function addMakeup(name: string, dates: readonly string[]): void {
  for (const key of dates) {
    if (calendar.has(key)) throw new Error(`节假日日期重复：${key}`);
    calendar.set(key, Object.freeze({ kind: "work", name: `${name}补班` }));
  }
}

// 国办发明电〔2025〕7号，2025-11-04。
addVacation("元旦", "2026-01-01", "2026-01-03");
addMakeup("元旦", ["2026-01-04"]);
addVacation("春节", "2026-02-15", "2026-02-23");
addMakeup("春节", ["2026-02-14", "2026-02-28"]);
addVacation("清明节", "2026-04-04", "2026-04-06");
addVacation("劳动节", "2026-05-01", "2026-05-05");
addMakeup("劳动节", ["2026-05-09"]);
addVacation("端午节", "2026-06-19", "2026-06-21");
addVacation("中秋节", "2026-09-25", "2026-09-27");
addVacation("国庆节", "2026-10-01", "2026-10-07");
addMakeup("国庆节", ["2026-09-20", "2026-10-10"]);

// 国务院办公厅通知，2026-11-05；MOHRSS全文转载2026-11-09。
addVacation("元旦", "2027-01-01", "2027-01-03");
addVacation("春节", "2027-02-05", "2027-02-13");
addMakeup("春节", ["2027-01-31", "2027-02-14"]);
addVacation("清明节", "2027-04-03", "2027-04-05");
addVacation("劳动节", "2027-05-01", "2027-05-05");
addMakeup("劳动节", ["2027-05-08"]);
addVacation("端午节", "2027-06-09", "2027-06-09");
addVacation("中秋节", "2027-09-15", "2027-09-15");
addVacation("国庆节", "2027-10-01", "2027-10-07");
addMakeup("国庆节", ["2027-09-26", "2027-10-09"]);

/** A listed official exception, or null for ordinary dates/unlisted years. */
export function getPublicHoliday(dateKey: string): PublicHoliday | null {
  const day = calendar.get(dateKey);
  return day ? { ...day } : null;
}

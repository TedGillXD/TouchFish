import { useEffect, useSyncExternalStore } from "react";
import { installHolidayData } from "./holidays";
import type { HolidayState } from "./holiday-types";

let snapshot: HolidayState = {
  status: "idle",
  years: [],
  lastChecked: null,
  message: "正在读取中国大陆节假日缓存…",
  systemProxy: true,
};
const listeners = new Set<() => void>();
let initializing: Promise<void> | undefined;
let revision = 0;
const requests = new Map<string, Promise<void>>();
const requestedAt = new Map<number, number>();

function accept(next: HolidayState): void {
  // The domain validates the whole replacement before changing the calendar.
  // Keep the last usable calendar if an IPC snapshot cannot be installed.
  try {
    installHolidayData(next.years);
    snapshot = next;
  } catch {
    snapshot = {
      ...snapshot,
      status: "error",
      message: "节假日数据无法识别，仍使用上次缓存，可重新更新。",
    };
  }
  revision++;
  for (const listener of listeners) listener();
}

/** Load the disk-backed calendar before normalizing any saved work records. */
export function initializeHolidayCalendar(): Promise<void> {
  if (initializing) return initializing;
  initializing = (async () => {
    const api = window.touchFish?.holidays;
    if (!api) {
      accept({
        ...snapshot,
        message: "桌面端会自动获取中国大陆节假日；暂无缓存时按排班估算。",
      });
      return;
    }
    api.onState(accept);
    const before = revision;
    try {
      const next = await api.getState();
      if (revision === before) accept(next);
    } catch {
      if (revision === before) accept({
        ...snapshot,
        status: "error",
        message: "无法读取节假日缓存，请在设置中重试；暂无数据的日期按排班估算。",
      });
    }
  })();
  return initializing;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
const getSnapshot = () => snapshot;

export function useHolidayState(): HolidayState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function yearsForDates(...dates: (string | undefined | null)[]): number[] {
  return [...new Set(dates.flatMap((date) => {
    const year = Number(date?.slice(0, 4));
    // The following year's notice can change this December's makeup days.
    return Number.isInteger(year) && year >= 1900 && year < 2299
      ? [year, year + 1] : [];
  }))].sort((a, b) => a - b);
}

export async function requestHolidayYears(years: number[], force = false): Promise<void> {
  await initializeHolidayCalendar();
  const api = window.touchFish?.holidays;
  if (!api) return;
  const now = Date.now();
  const wanted = [...new Set(years)].filter((year) =>
    Number.isInteger(year) && year >= 1900 && year <= 2299 &&
    (force || now - (requestedAt.get(year) ?? -Infinity) >= 5 * 60_000),
  ).sort((a, b) => a - b).slice(0, 6);
  if (!wanted.length) return;
  const key = `${force ? "force" : "auto"}:${wanted.join(",")}`;
  const pending = requests.get(key);
  if (pending) return pending;
  for (const year of wanted) requestedAt.set(year, now);
  const operation = (async () => {
    const before = revision;
    try {
      const next = await api.refresh(wanted, force);
      // Broadcasts arrive in order; an older invoke reply must not replace one.
      if (before === revision) accept(next);
    } catch {
      if (before === revision) accept({
        ...snapshot,
        status: "error",
        message: "节假日更新失败，已有缓存继续使用；暂无数据的日期按排班估算。",
      });
    }
  })().finally(() => { requests.delete(key); });
  requests.set(key, operation);
  return operation;
}

/** Request only when the displayed year set changes, never on the second tick. */
export function useHolidayYears(years: number[], enabled = true): void {
  const key = [...new Set(years)].sort((a, b) => a - b).join(",");
  useEffect(() => {
    if (enabled && key) void requestHolidayYears(key.split(",").map(Number));
  }, [key, enabled]);
}

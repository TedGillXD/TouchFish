import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeBvid } from "./bilibili-policy";
import type { BiliPlayback, BiliVideo } from "../src/bilibili-types";
import type { BiliHistoryEntry, BiliHistoryState } from "../src/bilibili-history-types";

interface HistoryFile { version: 1; entries: BiliHistoryEntry[] }
interface HistoryStorage {
  read(): Promise<unknown>;
  write(value: HistoryFile): Promise<void>;
}
interface HistoryOptions {
  directory: string;
  onState: (state: BiliHistoryState) => void;
  now?: () => number;
  /** Main-process test seam; never supplied by a renderer. */
  storage?: HistoryStorage;
}

const MAX_BYTES = 8 * 1024 * 1024;
const READ_ERROR = "视频历史暂时无法读取，原文件已保留；可清空历史后重新记录。";
const WRITE_ERROR = "视频历史保存失败，原有记录保持不变，请重试。";
const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, maximum: number) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum) : "";
const time = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const optionalTime = (value: unknown): value is number | null => value === null || time(value);
const recent = (entry: BiliHistoryEntry) => Math.max(entry.lastSearchedAt ?? 0, entry.lastPlayedAt ?? 0);
const sorted = (entries: BiliHistoryEntry[]) => entries.sort((left, right) => recent(right) - recent(left));
const copy = (entries: BiliHistoryEntry[]) => entries.map(entry => ({ ...entry }));

function diskStorage(directory: string): HistoryStorage {
  const path = join(directory, "bilibili-history.json");
  const temporary = join(directory, "bilibili-history.tmp.json");
  return {
    async read() {
      if ((await stat(path)).size > MAX_BYTES) throw new Error("History exceeds storage limit");
      const raw = await readFile(path, "utf8");
      if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error("History exceeds storage limit");
      return JSON.parse(raw);
    },
    async write(value) {
      const raw = JSON.stringify(value);
      if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error("History exceeds storage limit");
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, raw, { encoding: "utf8", mode: 0o600, flush: true });
      await rename(temporary, path);
    },
  };
}

function readEntries(value: unknown): BiliHistoryEntry[] {
  if (!plain(value) || value.version !== 1 || !Array.isArray(value.entries)) throw new Error("Invalid history");
  const entries = new Map<string, BiliHistoryEntry>();
  for (const raw of value.entries) {
    if (!plain(raw) || typeof raw.bvid !== "string" || !/^BV1[A-Za-z0-9]{9}$/i.test(raw.bvid) ||
      typeof raw.title !== "string" || typeof raw.owner !== "string" || typeof raw.duration !== "number" ||
      !Number.isFinite(raw.duration) || raw.duration < 0 || !optionalTime(raw.lastSearchedAt) || !optionalTime(raw.lastPlayedAt) ||
      raw.lastSearchedAt === null && raw.lastPlayedAt === null ||
      raw.lastMode !== null && raw.lastMode !== "audio" && raw.lastMode !== "video" ||
      raw.lastCid !== null && (!Number.isSafeInteger(raw.lastCid) || Number(raw.lastCid) <= 0) ||
      raw.lastPlayedAt !== null && (raw.lastMode === null || raw.lastCid === null)) throw new Error("Invalid history entry");
    const bvid = normalizeBvid(raw.bvid);
    const next: BiliHistoryEntry = {
      bvid, title: text(raw.title, 160), owner: text(raw.owner, 80), duration: Math.min(raw.duration, 604800),
      lastSearchedAt: raw.lastSearchedAt, lastPlayedAt: raw.lastPlayedAt,
      lastMode: raw.lastPlayedAt === null ? null : raw.lastMode as "audio" | "video",
      lastCid: raw.lastPlayedAt === null ? null : Number(raw.lastCid),
    };
    const previous = entries.get(bvid);
    if (!previous) entries.set(bvid, next);
    else {
      const newest = recent(next) > recent(previous) ? next : previous;
      const played = (next.lastPlayedAt ?? -1) > (previous.lastPlayedAt ?? -1) ? next : previous;
      entries.set(bvid, { ...newest,
        lastSearchedAt: previous.lastSearchedAt === null && next.lastSearchedAt === null ? null : Math.max(previous.lastSearchedAt ?? 0, next.lastSearchedAt ?? 0),
        lastPlayedAt: played.lastPlayedAt, lastMode: played.lastMode, lastCid: played.lastCid,
      });
    }
  }
  return sorted([...entries.values()]);
}

function metadata(video: BiliVideo) {
  return { title: text(video.title, 160), owner: text(video.owner, 80),
    duration: Number.isFinite(video.duration) && video.duration >= 0 ? Math.min(video.duration, 604800) : 0 };
}

/** Search and playback facts are committed separately from wages and login data. */
export async function createBilibiliHistory(options: HistoryOptions) {
  const storage = options.storage ?? diskStorage(options.directory);
  let entries: BiliHistoryEntry[] = [], error: string | null = null, unreadable = false;
  let queue: Promise<void> = Promise.resolve();
  let writeFailure: Error | null = null;
  const getState = (): BiliHistoryState => ({ entries: copy(entries), error });
  const publish = () => { try { options.onState(getState()); } catch { /* Reopened panels read a snapshot. */ } };
  const timestamp = () => {
    const now = options.now?.() ?? Date.now();
    if (!time(now)) throw new Error("系统时间暂不可用，无法记录视频历史。");
    return now;
  };
  const enqueue = (change: () => Promise<BiliHistoryState>) => {
    const operation = queue.then(change);
    queue = operation.then(() => {}, () => {});
    return operation;
  };
  const assertReadable = () => { if (unreadable) throw new Error(READ_ERROR); };
  async function commit(next: BiliHistoryEntry[]): Promise<BiliHistoryState> {
    const snapshot: HistoryFile = { version: 1, entries: copy(sorted(next)) };
    try { await storage.write(snapshot); }
    catch {
      error = WRITE_ERROR; writeFailure = new Error(WRITE_ERROR); publish();
      throw writeFailure;
    }
    entries = copy(snapshot.entries); error = null; unreadable = false; writeFailure = null; publish();
    return getState();
  }
  try { entries = readEntries(await storage.read()); }
  catch (cause) {
    if (!(plain(cause) && cause.code === "ENOENT")) { unreadable = true; error = READ_ERROR; }
  }
  publish();

  return {
    getState,
    replace(value: unknown) {
      return enqueue(() => commit(readEntries({ version: 1, entries: value })));
    },
    recordSearch(input: unknown) {
      return enqueue(async () => {
        assertReadable();
        const bvid = normalizeBvid(input), previous = entries.find(entry => entry.bvid === bvid);
        const next: BiliHistoryEntry = previous ? { ...previous } : {
          bvid, title: "", owner: "", duration: 0, lastSearchedAt: null, lastPlayedAt: null, lastMode: null, lastCid: null,
        };
        next.lastSearchedAt = Math.max(timestamp(), previous?.lastSearchedAt ?? 0);
        return commit([next, ...entries.filter(entry => entry.bvid !== bvid)]);
      });
    },
    recordVideo(video: BiliVideo) {
      return enqueue(async () => {
        assertReadable();
        const bvid = normalizeBvid(video?.bvid);
        // Deletion is authoritative: a late metadata response cannot recreate it.
        if (!entries.some(entry => entry.bvid === bvid)) return getState();
        return commit(entries.map(entry => entry.bvid === bvid ? { ...entry, ...metadata(video) } : { ...entry }));
      });
    },
    recordPlay(playback: BiliPlayback, createIfMissing = true) {
      return enqueue(async () => {
        assertReadable();
        const bvid = normalizeBvid(playback?.video?.bvid);
        if (!["audio", "video"].includes(playback.mode) || !Number.isSafeInteger(playback.cid) || playback.cid <= 0)
          throw new Error("播放历史参数无效。");
        const previous = entries.find(entry => entry.bvid === bvid);
        // Player refreshes may update an existing record, but deletion remains
        // authoritative until another explicit search or main-panel play.
        if (!createIfMissing && !previous) return getState();
        const next: BiliHistoryEntry = {
          bvid, ...metadata(playback.video), lastSearchedAt: previous?.lastSearchedAt ?? null,
          lastPlayedAt: Math.max(timestamp(), previous?.lastPlayedAt ?? 0), lastMode: playback.mode, lastCid: playback.cid,
        };
        return commit([next, ...entries.filter(entry => entry.bvid !== bvid)]);
      });
    },
    remove(input: unknown) {
      return enqueue(async () => {
        assertReadable();
        const bvid = normalizeBvid(input);
        if (!entries.some(entry => entry.bvid === bvid)) return getState();
        return commit(entries.filter(entry => entry.bvid !== bvid).map(entry => ({ ...entry })));
      });
    },
    clear: () => enqueue(() => commit([])),
    async flush() { await queue; if (writeFailure) throw writeFailure; },
  };
}

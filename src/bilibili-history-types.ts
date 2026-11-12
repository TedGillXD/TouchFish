import type { BiliMode } from "./bilibili-types";

/** Local, deduplicated video references. Credentials and stream URLs stay out. */
export interface BiliHistoryEntry {
  bvid: string;
  title: string;
  owner: string;
  duration: number;
  lastSearchedAt: number | null;
  lastPlayedAt: number | null;
  lastMode: BiliMode | null;
  lastCid: number | null;
}

export interface BiliHistoryState {
  entries: BiliHistoryEntry[];
  error: string | null;
}

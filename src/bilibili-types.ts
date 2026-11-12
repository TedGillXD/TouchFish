export type BiliMode = "audio" | "video";
export interface BiliAuthState {
  status: "logged-out" | "loading" | "qr" | "scanned" | "authenticated" | "expired" | "error";
  loggedIn: boolean;
  user: { uid: number; name: string; avatar: string | null } | null;
  qrDataUrl: string | null;
  expiresAt: number | null;
  message: string;
}
export interface BiliPage { cid: number; page: number; title: string; duration: number }
export interface BiliVideo {
  bvid: string;
  title: string;
  owner: string;
  cover: string | null;
  duration: number;
  pages: BiliPage[];
}
export interface BiliQuality { id: number; label: string }
export interface BiliPlayRequest { bvid: string; mode: BiliMode; cid?: number; quality?: number }
export interface BiliPlayback {
  /** Assigned only by the desktop player when a source is opened. */
  transportRevision?: number;
  video: BiliVideo;
  cid: number;
  mode: BiliMode;
  quality: number;
  qualities: BiliQuality[];
  videoUrl: string | null;
  audioUrl: string | null;
  expiresAt: number;
}
export interface BiliDanmaku { time: number; text: string; color: number; mode: number }
export interface BiliPlayerState { open: boolean; mode: BiliMode; title: string; bvid: string | null }

/** Minimal, non-sensitive media status shared with the wage companion. */
export interface BiliTransportReport {
  revision: number;
  ready: boolean;
  playing: boolean;
  playIntent: boolean;
  buffering: boolean;
  ended: boolean;
  failed: boolean;
}
export interface BiliTransportState extends BiliTransportReport { open: boolean }
export interface BiliTransportCommand { id: number; revision: number; playing: boolean }

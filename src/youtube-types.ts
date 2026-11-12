import type { BiliTransportState } from "./bilibili-types";

export type YouTubeBrowser = "default" | "chrome" | "edge";
export interface YouTubePlayerState {
  connected: boolean;
  browser: YouTubeBrowser | null;
  open: boolean;
  visible: boolean;
  minimized: boolean;
  loading: boolean;
  concealed: boolean;
  title: string;
  videoId: string | null;
  url: string | null;
  message: string;
  currentTime: number;
  duration: number;
  volume: number;
  playbackRate: number;
}
export interface YouTubeBridge {
  getState(): Promise<YouTubePlayerState>;
  connectBrowser(browser: YouTubeBrowser): Promise<YouTubePlayerState>;
  open(input: string): Promise<YouTubePlayerState>;
  getTransportState(): Promise<BiliTransportState>;
  setPlaying(playing: boolean, revision: number): Promise<BiliTransportState>;
  setVolume(volume: number): Promise<void>;
  setPlaybackRate(rate: number): Promise<void>;
  show(): void;
  minimize(): void;
  close(): void;
  openInBrowser(input?: string): Promise<void>;
  openLogin(): Promise<void>;
  openExtensionFolder(): Promise<void>;
  onState(callback: (state: YouTubePlayerState) => void): () => void;
  onTransportState(callback: (state: BiliTransportState) => void): () => void;
}

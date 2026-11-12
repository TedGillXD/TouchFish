import type { BiliTransportState } from "./bilibili-types";

export type MediaProvider = "bilibili" | "youtube";
export interface MediaTransportState extends BiliTransportState { provider: MediaProvider | null }
export interface MediaControlApi {
  getTransportState(): Promise<MediaTransportState>;
  setPlaying(playing: boolean, revision: number, provider: MediaProvider): Promise<BiliTransportState>;
  onTransportState(callback: (state: MediaTransportState) => void): () => void;
}

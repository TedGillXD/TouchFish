import type { AppData } from "./core";
import type { UpdateState } from "./update-types";
import type { FloatingState } from "./floating-types";
import type { HolidayState } from "./holiday-types";
import type { BiliAuthState, BiliDanmaku, BiliMode, BiliPlayback, BiliPlayerState, BiliPlayRequest, BiliVideo } from "./bilibili-types";

declare global {
  interface Window {
    touchFish?: {
      readonly platform: string;
      loadData(): Promise<AppData | null>;
      saveData(data: AppData): Promise<void>;
      onData(callback: (data: AppData) => void): () => void;
      hide(): void;
      quit(): void;
      getLogin(): Promise<boolean>;
      setLogin(enabled: boolean): Promise<void>;
      onSettings(callback: () => void): () => void;
      updateStatus?(message: string): void;
      bilibili: {
        getAuth(): Promise<BiliAuthState>;
        createQr(): Promise<BiliAuthState>;
        cancelLogin(): Promise<void>;
        logout(): Promise<BiliAuthState>;
        getVideo(bvid: string): Promise<BiliVideo>;
        play(request: BiliPlayRequest): Promise<BiliPlayback>;
        getPlayback(): Promise<BiliPlayback | null>;
        getPlayerState(): Promise<BiliPlayerState>;
        getDanmaku(cid: number): Promise<BiliDanmaku[]>;
        setPlayerMode(mode: BiliMode): Promise<BiliPlayback>;
        openVideoPage(): Promise<void>;
        closePlayer(): void;
        minimizePlayer(): void;
        showPlayer(): void;
        onAuth(callback: (state: BiliAuthState) => void): () => void;
        onPlayback(callback: (state: BiliPlayback) => void): () => void;
        onPlayerState(callback: (state: BiliPlayerState) => void): () => void;
      };
      holidays: {
        getState(): Promise<HolidayState>;
        refresh(years?: number[], force?: boolean): Promise<HolidayState>;
        onState(callback: (state: HolidayState) => void): () => void;
      };
      floating: {
        getState(): Promise<FloatingState>;
        setEnabled(enabled: boolean): Promise<FloatingState>;
        setExpanded(expanded: boolean): Promise<FloatingState>;
        setPrivacy(privacy: boolean): Promise<FloatingState>;
        openPanel(): void;
        menu(): void;
        onState(callback: (state: FloatingState) => void): () => void;
      };
      updater: {
        getState(): Promise<UpdateState>;
        check(): Promise<UpdateState>;
        download(): Promise<UpdateState>;
        install(): Promise<void>;
        openReleasePage(): Promise<void>;
        onState(callback: (state: UpdateState) => void): () => void;
      };
    };
  }
}
export {};

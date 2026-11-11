import type { AppData } from "./core";
import type { UpdateState } from "./update-types";
import type { FloatingState } from "./floating-types";
import type { HolidayState } from "./holiday-types";

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

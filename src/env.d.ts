import type { AppData } from "./core";
import type { UpdateState } from "./update-types";

declare global {
  interface Window {
    touchFish?: {
      readonly platform: string;
      loadData(): Promise<AppData | null>;
      saveData(data: AppData): Promise<void>;
      hide(): void;
      quit(): void;
      getLogin(): Promise<boolean>;
      setLogin(enabled: boolean): Promise<void>;
      onSettings(callback: () => void): () => void;
      updateStatus?(message: string): void;
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

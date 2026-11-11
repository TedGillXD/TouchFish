import type { AppData } from "./core";

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
    };
  }
}
export {};

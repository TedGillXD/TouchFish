import { contextBridge, ipcRenderer } from "electron";
import type { AppData } from "../src/core";

// Expose individual operations; never expose ipcRenderer or Node to the page.
contextBridge.exposeInMainWorld("touchFish", {
  platform: process.platform,
  loadData: (): Promise<AppData | null> => ipcRenderer.invoke("data:load"),
  saveData: (data: AppData): Promise<void> =>
    ipcRenderer.invoke("data:save", data),
  hide: (): void => ipcRenderer.send("window:hide"),
  quit: (): void => ipcRenderer.send("app:quit"),
  getLogin: (): Promise<boolean> => ipcRenderer.invoke("login:get"),
  setLogin: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("login:set", enabled),
  updateStatus: (message: string): void =>
    ipcRenderer.send("tray:status", message),
  onSettings: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on("window:settings", listener);
    return () => ipcRenderer.removeListener("window:settings", listener);
  },
});

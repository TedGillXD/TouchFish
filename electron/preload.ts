import { contextBridge, ipcRenderer } from "electron";
import type { AppData } from "../src/core";
import type { UpdateState } from "../src/update-types";
import type { FloatingState } from "../src/floating-types";

// Expose individual operations; never expose ipcRenderer or Node to the page.
contextBridge.exposeInMainWorld("touchFish", {
  platform: process.platform,
  loadData: (): Promise<AppData | null> => ipcRenderer.invoke("data:load"),
  saveData: (data: AppData): Promise<void> =>
    ipcRenderer.invoke("data:save", data),
  onData: (callback: (data: AppData) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: AppData) => callback(data);
    ipcRenderer.on("data:changed", listener);
    return () => ipcRenderer.removeListener("data:changed", listener);
  },
  hide: (): void => ipcRenderer.send("window:hide"),
  quit: (): void => ipcRenderer.send("app:quit"),
  getLogin: (): Promise<boolean> => ipcRenderer.invoke("login:get"),
  setLogin: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("login:set", enabled),
  updateStatus: (message: string): void =>
    ipcRenderer.send("tray:status", message),
  floating: {
    getState: (): Promise<FloatingState> => ipcRenderer.invoke("floating:get"),
    setEnabled: (enabled: boolean): Promise<FloatingState> => ipcRenderer.invoke("floating:enabled", enabled),
    setExpanded: (expanded: boolean): Promise<FloatingState> => ipcRenderer.invoke("floating:expanded", expanded),
    setPrivacy: (privacy: boolean): Promise<FloatingState> => ipcRenderer.invoke("floating:privacy", privacy),
    openPanel: (): void => ipcRenderer.send("floating:open"),
    menu: (): void => ipcRenderer.send("floating:menu"),
    onState: (callback: (state: FloatingState) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: FloatingState) => callback(state);
      ipcRenderer.on("floating:state", listener);
      return () => ipcRenderer.removeListener("floating:state", listener);
    },
  },
  updater: {
    getState: (): Promise<UpdateState> => ipcRenderer.invoke("updater:get"),
    check: (): Promise<UpdateState> => ipcRenderer.invoke("updater:check"),
    download: (): Promise<UpdateState> =>
      ipcRenderer.invoke("updater:download"),
    install: (): Promise<void> => ipcRenderer.invoke("updater:install"),
    openReleasePage: (): Promise<void> =>
      ipcRenderer.invoke("updater:open-release"),
    onState: (callback: (state: UpdateState) => void): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        state: UpdateState,
      ) => callback(state);
      ipcRenderer.on("updater:state", listener);
      return () => ipcRenderer.removeListener("updater:state", listener);
    },
  },
  onSettings: (callback: () => void): (() => void) => {
    const listener = () => callback();
    ipcRenderer.on("window:settings", listener);
    return () => ipcRenderer.removeListener("window:settings", listener);
  },
});

import { contextBridge, ipcRenderer } from "electron";
import type { HongguoWindowAction } from "../src/hongguo-types";

contextBridge.exposeInMainWorld("hongguoWindow", {
  action: (action: HongguoWindowAction) => ipcRenderer.send("hongguo:window-action", action),
});

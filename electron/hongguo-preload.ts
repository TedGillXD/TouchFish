import { ipcRenderer } from "electron";

type MediaGate = "open" | "concealed" | "paused";

// This preload stays in the isolated world. The official page receives no bridge.
if (process.isMainFrame) {
  let gate: MediaGate = "concealed";

  const pauseMedia = () => {
    for (const media of document.querySelectorAll<HTMLMediaElement>("video, audio")) media.pause();
  };
  const applyGate = (value: unknown) => {
    gate = value === "open" || value === "paused" ? value : "concealed";
    if (gate !== "open") pauseMedia();
  };

  const interceptPlayback = (event: Event) => {
    if (gate !== "open" && event.target instanceof HTMLMediaElement) event.target.pause();
  };
  document.addEventListener("play", interceptPlayback, true);
  document.addEventListener("playing", interceptPlayback, true);

  const acceptLocalInput = (event: Event) => {
    if (gate !== "paused" || !event.isTrusted || document.visibilityState !== "visible") return;
    if (event instanceof KeyboardEvent && (event.altKey || event.ctrlKey || event.metaKey)) return;
    gate = "open";
    ipcRenderer.send("hongguo:media-interaction");
  };
  document.addEventListener("pointerdown", acceptLocalInput, true);
  document.addEventListener("keydown", acceptLocalInput, true);

  ipcRenderer.on("hongguo:privacy", (_event, value: unknown, request: unknown) => {
    applyGate(value);
    if (typeof request === "number") ipcRenderer.send("hongguo:privacy-ack", request);
  });
  // A new document inherits the gate before any page script can autoplay.
  applyGate(ipcRenderer.sendSync("hongguo:privacy-state"));
}

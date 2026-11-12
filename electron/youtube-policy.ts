export const YOUTUBE_EXTENSION_ID = "pfcfmmigpdajeglmpmipoahblahejeij";
export const YOUTUBE_BRIDGE_PROTOCOL = "touchfish-youtube-v1";
export const YOUTUBE_EXTENSION_ORIGIN = `chrome-extension://${YOUTUBE_EXTENSION_ID}`;
const hosts = new Set(["www.youtube.com", "youtube.com", "m.youtube.com", "music.youtube.com"]);
const idPattern = /^[A-Za-z0-9_-]{11}$/;

export function normalizeYouTubeVideo(value: unknown): { videoId: string; url: string } {
  if (typeof value !== "string" || value.length > 2048) throw new Error("请输入有效的 YouTube 视频链接或 11 位视频 ID。");
  const input = value.trim();
  if (idPattern.test(input)) return { videoId: input, url: `https://www.youtube.com/watch?v=${input}` };
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("请输入有效的 YouTube 视频链接或 11 位视频 ID。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
    (!hosts.has(url.hostname) && !["youtu.be", "www.youtu.be"].includes(url.hostname)))
    throw new Error("仅支持 YouTube 官方 HTTPS 视频链接。");
  const match = /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname);
  const videoId = url.hostname.endsWith("youtu.be") ? /^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1]
    : url.pathname === "/watch" ? url.searchParams.get("v") : match?.[1];
  if (!videoId || !idPattern.test(videoId)) throw new Error("链接中没有有效的 YouTube 视频 ID。");
  return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
}

export function validYouTubeBrowser(value: unknown): value is "default" | "chrome" | "edge" {
  return value === "default" || value === "chrome" || value === "edge";
}

export function isYouTubeExtensionOrigin(value: unknown): boolean {
  return value === YOUTUBE_EXTENSION_ORIGIN;
}

export function isBridgeHost(host: unknown, port: number): boolean {
  return host === `127.0.0.1:${port}`;
}

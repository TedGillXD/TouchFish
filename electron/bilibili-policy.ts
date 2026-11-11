import { createHash } from "node:crypto";
import type { BiliDanmaku } from "../src/bilibili-types";

// WBI key permutation follows fantasytyx/bv's bili-api implementation (MIT,
// copyright aaa1115910). Only the web protocol is used, never Android app keys.
const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const MEDIA_DOMAINS = ["bilivideo.com", "bilivideo.cn", "hdslb.com"];
const API_HOSTS = new Set(["api.bilibili.com", "passport.bilibili.com", "www.bilibili.com"]);

export function normalizeBvid(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("请输入有效的 BV 号。");
  let input = value.trim();
  if (/^https:\/\//i.test(input)) {
    let url: URL;
    try { url = new URL(input); } catch { throw new Error("请输入 BV 号或哔哩哔哩视频链接。"); }
    if (!["www.bilibili.com", "bilibili.com", "m.bilibili.com"].includes(url.hostname) ||
      url.username || url.password || url.port) throw new Error("仅支持哔哩哔哩视频链接。");
    const match = /^\/video\/(BV1[A-Za-z0-9]{9})\/?$/i.exec(url.pathname);
    if (!match) throw new Error("链接中没有有效的 BV 号。");
    input = match[1];
  }
  if (!/^BV1[A-Za-z0-9]{9}$/i.test(input)) throw new Error("BV 号应为 BV1 开头的 12 位编号。");
  return `BV${input.slice(2)}`;
}

export function trustedBiliApiUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || !API_HOSTS.has(url.hostname) || url.username || url.password ||
    url.port && url.port !== "443") throw new Error("哔哩哔哩请求地址无效。");
  return url;
}

export function trustedBiliMediaUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" ||
    !MEDIA_DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)))
    throw new Error("视频返回了无法验证的播放地址。");
  return url;
}

/** API responses sometimes advertise HTTP images; request their HTTPS variant. */
export function normalizeBiliMediaUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 16_384) throw new Error("视频地址格式不正确。");
  const url = value.startsWith("//") ? `https:${value}` : value.replace(/^http:\/\//, "https://");
  return trustedBiliMediaUrl(url).toString();
}

export function signWbi(params: Record<string, string | number>, imgKey: string, subKey: string, timestamp: number): string {
  if (!/^[a-f0-9]{32}$/i.test(imgKey) || !/^[a-f0-9]{32}$/i.test(subKey) || !Number.isFinite(timestamp))
    throw new Error("播放签名暂未就绪，请重试。");
  const combined = imgKey + subKey;
  const mixinKey = MIXIN.map(index => combined[index]).join("").slice(0, 32);
  const values = { ...params, wts: Math.floor(timestamp / 1000) } as Record<string, string | number>;
  delete values.w_rid;
  const query = Object.keys(values).sort().map(key =>
    `${encodeURIComponent(key)}=${encodeURIComponent(String(values[key]).replace(/[!'()*]/g, ""))}`,
  ).join("&");
  return `${query}&w_rid=${createHash("md5").update(query + mixinKey).digest("hex")}`;
}

export function safeBiliError(code: number): string {
  if (code === -101) return "登录已过期，请重新扫码登录。";
  if (code === -403 || code === 403) return "当前账号没有此视频或清晰度的播放权限。";
  if (code === -404 || code === 62002 || code === 62004) return "视频不存在、已删除或暂不可观看。";
  if (code === -352 || code === -412 || code === 412) return "哔哩哔哩暂时限制了此网络请求，请稍后重试或切换系统网络。";
  if (code === 10015002 || code === 6002003) return "该视频受到地区或账号权限限制，请在哔哩哔哩确认观看权限。";
  return "哔哩哔哩暂时无法完成请求，请稍后重试。";
}

function decodeXmlText(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(?:lt|gt|amp|quot|apos|#\d+|#x[a-f0-9]+);/gi, entity => {
      const common: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'" };
      if (common[entity.toLowerCase()]) return common[entity.toLowerCase()];
      const point = entity[2].toLowerCase() === "x" ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point) : "";
    }).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
}

/** Parse only inert <d> text records. No document/entity parser or HTML is used. */
export function parseDanmakuXml(xml: string): BiliDanmaku[] {
  if (Buffer.byteLength(xml) > 8 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("弹幕数据格式不正确。");
  const result: BiliDanmaku[] = [];
  const pattern = /<d\s+p=(['"])([^'"]*)\1[^>]*>([\s\S]*?)<\/d>/g;
  for (const match of xml.matchAll(pattern)) {
    if (result.length >= 20_000) break;
    const [timeText, modeText, , colorText] = match[2].split(",");
    const time = Number(timeText), mode = Number(modeText), color = Number(colorText);
    const text = decodeXmlText(match[3]).trim();
    if (!text || !Number.isFinite(time) || time < 0 || time > 2_592_000 || ![1,4,5,6].includes(mode)) continue;
    result.push({ time, mode, color: Number.isInteger(color) && color >= 0 && color <= 0xffffff ? color : 0xffffff, text });
  }
  return result.sort((a, b) => a.time - b.time);
}

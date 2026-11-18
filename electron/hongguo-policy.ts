export const HONGGUO_HOME = "https://hongguoduanju.com/";
export const HONGGUO_PARTITION = "persist:touchfish-hongguo";

const siteHosts = new Set(["hongguoduanju.com", "www.hongguoduanju.com"]);
const legalPages = new Set([
  "https://web.qznovel.com/wap-hongguo/dr-agreement-v2-ad.html",
  "https://web.qznovel.com/wap-hongguo/dr-privacy-v3-ad.html",
]);

function parseHttpsUrl(input: string): URL | null {
  if (input.length > 2048 || !/^https:\/\//i.test(input) || /[\x00-\x20\x7f\\]/.test(input)) return null;
  try {
    const url = new URL(input);
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url : null;
  } catch {
    return null;
  }
}

export function normalizeHongguoUrl(input: unknown): string | undefined {
  if (input === undefined || (typeof input === "string" && !input.trim())) return undefined;
  const url = typeof input === "string" ? parseHttpsUrl(input.trim()) : null;
  if (!url || !siteHosts.has(url.hostname)) throw new Error("请输入红果短剧官网的 HTTPS 链接。");
  return url.href;
}

export function isHongguoWebsite(input: string): boolean {
  const url = parseHttpsUrl(input);
  return !!url && siteHosts.has(url.hostname);
}

export function isHongguoNavigation(input: string): boolean {
  const url = parseHttpsUrl(input);
  return !!url && (siteHosts.has(url.hostname) || legalPages.has(url.href));
}

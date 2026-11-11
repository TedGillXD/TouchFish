export const RELEASES_URL = "https://github.com/TedGillXD/TouchFish/releases";
export const LATEST_RELEASE_API =
  "https://api.github.com/repos/TedGillXD/TouchFish/releases/latest";

export type ReleaseFileKind = "setup" | "portable" | "dmg" | "zip" | "appimage";
export interface ReleaseFile {
  name: string;
  platform: "win32" | "darwin" | "linux";
  arch: "x64" | "arm64";
  kind: ReleaseFileKind;
  size: number;
  sha256: string;
  sha512: string;
}
export interface ReleaseManifest {
  schemaVersion: 1;
  version: string;
  files: ReleaseFile[];
}
export interface ReleaseTarget {
  version: string;
  tag: string;
  releaseUrl: string;
  downloadBase: string;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function stableVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match =
    /^(?:v)?((?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8}))$/.exec(
      value,
    );
  return match?.[1] ?? null;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = stableVersion(candidate),
    previous = stableVersion(current);
  if (!next || !previous) return false;
  const left = next.split(".").map(Number),
    right = previous.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

export function parseRelease(value: unknown): ReleaseTarget {
  if (!object(value) || value.draft === true || value.prerelease === true)
    throw new Error("INVALID_RELEASE");
  const version = stableVersion(value.tag_name);
  if (!version) throw new Error("INVALID_RELEASE");
  const tag = String(value.tag_name);
  return {
    version,
    tag,
    releaseUrl: `${RELEASES_URL}/tag/${encodeURIComponent(tag)}`,
    downloadBase: `${RELEASES_URL}/download/${encodeURIComponent(tag)}/`,
  };
}

/** Manifest entries are filenames, never paths or executable commands. */
export function parseManifest(
  value: unknown,
  expectedVersion: string,
): ReleaseManifest {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    value.version !== expectedVersion ||
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > 40
  )
    throw new Error("INVALID_MANIFEST");
  const names = new Set<string>();
  const files: ReleaseFile[] = value.files.map((raw) => {
    if (
      !object(raw) ||
      typeof raw.name !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._+-]{1,180}$/.test(raw.name) ||
      names.has(raw.name) ||
      !["win32", "darwin", "linux"].includes(String(raw.platform)) ||
      !["x64", "arm64"].includes(String(raw.arch)) ||
      !["setup", "portable", "dmg", "zip", "appimage"].includes(
        String(raw.kind),
      ) ||
      typeof raw.size !== "number" ||
      !Number.isSafeInteger(raw.size) ||
      raw.size < 1 ||
      raw.size > 2 * 1024 ** 3 ||
      typeof raw.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(raw.sha256) ||
      typeof raw.sha512 !== "string" ||
      !/^[A-Za-z0-9+/]{86}==$/.test(raw.sha512) ||
      Buffer.from(raw.sha512, "base64").length !== 64
    )
      throw new Error("INVALID_MANIFEST");
    names.add(raw.name);
    const expectedName =
      raw.platform === "win32" &&
      ["setup", "portable"].includes(String(raw.kind))
        ? `TouchFish-${expectedVersion}-win-${raw.arch}-${raw.kind}.exe`
        : raw.platform === "darwin" && ["dmg", "zip"].includes(String(raw.kind))
          ? `TouchFish-${expectedVersion}-mac-${raw.arch}.${raw.kind}`
          : raw.platform === "linux" && raw.kind === "appimage"
            ? `TouchFish-${expectedVersion}-linux-${raw.arch === "x64" ? "x86_64" : raw.arch}.AppImage`
            : null;
    if (
      raw.name !== expectedName ||
      Buffer.from(raw.sha512, "base64").toString("base64") !== raw.sha512
    )
      throw new Error("INVALID_MANIFEST");
    return {
      name: raw.name,
      platform: raw.platform as ReleaseFile["platform"],
      arch: raw.arch as ReleaseFile["arch"],
      kind: raw.kind as ReleaseFileKind,
      size: raw.size,
      sha256: raw.sha256,
      sha512: raw.sha512,
    };
  });
  return { schemaVersion: 1, version: expectedVersion, files };
}

export function chooseReleaseFile(
  manifest: ReleaseManifest,
  platform: string,
  arch: string,
): ReleaseFile | null {
  const kind: ReleaseFileKind | null =
    platform === "win32"
      ? "setup"
      : platform === "darwin"
        ? "dmg"
        : platform === "linux"
          ? "appimage"
          : null;
  return (
    manifest.files.find(
      (file) =>
        file.platform === platform && file.arch === arch && file.kind === kind,
    ) ?? null
  );
}

/** Allow official GitHub download redirects, with TLS verification always enabled. */
export function trustedUpdateUrl(value: string): URL {
  const url = new URL(value);
  const hosts = [
    "api.github.com",
    "github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
    "github-releases.githubusercontent.com",
  ];
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !hosts.includes(url.hostname)
  )
    throw new Error("UNTRUSTED_UPDATE_URL");
  return url;
}

export function safeUpdateError(
  error: unknown,
  phase: "check" | "download" | "install",
  proxyAuth = false,
): string {
  const text =
    error instanceof Error
      ? `${(error as NodeJS.ErrnoException).code ?? ""} ${error.message}`
      : "";
  if (proxyAuth || /PROXY_AUTH|407/.test(text))
    return "系统代理要求身份验证，请先在系统代理客户端完成登录后重试。";
  if (/TIMEOUT|timed out|Timeout|ERR_TIMED_OUT/i.test(text))
    return "更新连接超时，请检查系统代理和网络后重试。";
  if (/HASH|checksum|sha512|sha256|SIGNATURE/i.test(text))
    return "更新文件校验失败，已阻止安装。请重新检查并下载。";
  if (/CERT_|certificate/i.test(text))
    return "安全连接验证失败，请检查系统时间和代理证书配置。";
  if (/HTTP_404|NO_RELEASE/.test(text))
    return "暂未找到正式发布版本，请稍后重试。";
  if (/INVALID_MANIFEST|INVALID_RELEASE|UNTRUSTED_UPDATE_URL/.test(text))
    return "更新信息校验失败，已停止更新。请稍后重试或查看官方发布页。";
  if (/UNSUPPORTED_ASSET/.test(text))
    return "该版本暂未提供适合此系统或处理器的安装包，请查看官方发布页。";
  if (/SAVE_FAILED/.test(text))
    return "本地工作记录尚未保存成功，已取消安装，请先解决保存问题。";
  return phase === "check"
    ? "检查更新失败，请检查系统代理及网络后重试。"
    : phase === "download"
      ? "下载更新失败，请检查系统代理及网络后重试。"
      : "无法启动安装，请重试或查看官方发布页。";
}

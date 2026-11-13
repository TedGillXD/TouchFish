import type { GitSyncConfig } from "../src/data-management-types";
export type { GitSyncConfig } from "../src/data-management-types";
export const GIT_BACKUP_PATH = "touchfish-backup.json";

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Git's network transports only; never an executable helper or a local path. */
export function normalizeGitRepository(value: unknown): string {
  const invalid = () => new Error("请输入 HTTPS 或 SSH 格式的 Git 仓库地址。");
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) throw invalid();
  if (value.startsWith("https://") || value.startsWith("ssh://")) {
    let url: URL;
    try { url = new URL(value); } catch { throw invalid(); }
    if (!url.hostname || url.password || url.search || url.hash ||
      (url.protocol === "https:" && url.username) ||
      !["https:", "ssh:"].includes(url.protocol) || !url.pathname || url.pathname === "/") throw invalid();
    // Reject encoded credentials/control characters instead of storing a token
    // in the backup or feeding a disguised helper/option to Git.
    let path: string;
    try { path = decodeURIComponent(url.pathname); } catch { throw invalid(); }
    if (/[\u0000-\u001f\u007f]/.test(path) || path.split("/").some(part => part === "..")) throw invalid();
    if (url.username && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(url.username)) throw invalid();
    return url.toString().replace(/\/$/, "");
  }
  const scp = /^([A-Za-z0-9][A-Za-z0-9._-]*)@([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?):([A-Za-z0-9._/-]+)$/.exec(value);
  if (!scp || scp[3].startsWith("/") || scp[3].startsWith("-") || scp[3].split("/").some(part => !part || part === "..")) throw invalid();
  return value;
}

/** Mirrors check-ref-format for one refs/heads name, without spawning a shell. */
export function normalizeGitBranch(value: unknown): string {
  const invalid = () => new Error("分支名无效，请使用 main 等有效 Git 分支名。");
  if (typeof value !== "string" || value.length > 200) throw invalid();
  const branch = value.trim() || "main";
  if (/^[/-]/.test(branch) || /[\u0000-\u0020\u007f~^:?*\[\\]/.test(branch) ||
    branch === "@" || branch.endsWith("/") || branch.endsWith(".") || branch.includes("..") || branch.includes("@{") ||
    branch.split("/").some(part => !part || part.startsWith(".") || /\.lock$/i.test(part))) throw invalid();
  return branch;
}

export function normalizeGitSyncConfig(value: unknown): GitSyncConfig {
  if (!plain(value)) throw new Error("Git 同步配置无效。");
  return { repository: normalizeGitRepository(value.repository), branch: normalizeGitBranch(value.branch ?? "main") };
}

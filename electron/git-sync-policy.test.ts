import assert from "node:assert/strict";
import test from "node:test";
import { GIT_BACKUP_PATH, normalizeGitBranch, normalizeGitRepository, normalizeGitSyncConfig } from "./git-sync-policy";

test("Git sync accepts HTTPS, SSH and scp repositories without retaining credentials", () => {
  assert.equal(GIT_BACKUP_PATH, "touchfish-backup.json");
  for (const url of ["https://github.com/user/private.git", "https://gitee.com/user/data", "https://git.example.org:8443/group/sub/repo.git", "ssh://git@git.example.org:2222/user/data.git", "git@github.com:user/private.git"])
    assert.equal(normalizeGitRepository(url), url);
  assert.deepEqual(normalizeGitSyncConfig({ repository: "git@github.com:user/private.git", branch: "backup/data" }), { repository: "git@github.com:user/private.git", branch: "backup/data" });
  assert.equal(normalizeGitSyncConfig({ repository: "https://github.com/u/r.git" }).branch, "main");
});

test("Git sync rejects executable transports, local paths, inline tokens and control characters", () => {
  for (const value of [null, 1, {}, "", "-u", "ext::sh -c evil", "file:///tmp/private.git", "D:\\repo.git", "../repo", "git://example.org/u/r", "http://example.org/u/r", "https://token@github.com/u/r", "https://u:secret@github.com/u/r", "ssh://u:secret@example.org/u/r", "https://example.org/u/r?token=secret", "https://example.org/u/r#token", "https://example.org/", "https://example.org/u/%0ar", "git@example.org:../../private", "git@example.org:-x", "git@example.org:repo\n--upload-pack=evil"])
    assert.throws(() => normalizeGitRepository(value));
});

test("Git branch names cannot become options or revision expressions", () => {
  for (const branch of ["main", "backup/data", "feature-1.2", "个人备份"]) assert.equal(normalizeGitBranch(branch), branch);
  assert.equal(normalizeGitBranch(""), "main");
  for (const branch of [null, 123, "-x", "/main", "main/", ".private", "a/.b", "a..b", "main.lock", "main.", "a//b", "a@{b", "@", "a:b", "a b", "a\nb", "a~1", "a^", "a?", "a[0]", "a\\b", "a*"]) assert.throws(() => normalizeGitBranch(branch));
});

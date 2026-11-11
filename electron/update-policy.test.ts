import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  chooseReleaseFile,
  isNewerVersion,
  parseManifest,
  parseRelease,
  safeUpdateError,
  stableVersion,
  trustedUpdateUrl,
} from "./update-policy";

const bytes = Buffer.from("verified release fixture");
const file = {
  name: "TouchFish-1.4.0-win-x64-setup.exe",
  platform: "win32",
  arch: "x64",
  kind: "setup",
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  sha512: createHash("sha512").update(bytes).digest("base64"),
};
const manifest = () => ({
  schemaVersion: 1,
  version: "1.4.0",
  files: [{ ...file }],
});

test("stable update versions compare numerically and never enable downgrades or prereleases", () => {
  assert.equal(stableVersion("v1.4.0"), "1.4.0");
  assert.equal(isNewerVersion("1.10.0", "1.9.9"), true);
  assert.equal(isNewerVersion("1.4.0", "1.4.0"), false);
  assert.equal(isNewerVersion("1.3.9", "1.4.0"), false);
  for (const version of [
    "1.4.0-beta.1",
    "1.04.0",
    "../1.4.0",
    "v1.4.0/../../x",
    "1.4",
  ])
    assert.equal(stableVersion(version), null);
});

test("only a stable release tag creates official repository download URLs", () => {
  const target = parseRelease({
    tag_name: "v1.4.0",
    draft: false,
    prerelease: false,
    html_url: "https://evil.invalid",
  });
  assert.equal(
    target.downloadBase,
    "https://github.com/TedGillXD/TouchFish/releases/download/v1.4.0/",
  );
  assert.equal(
    target.releaseUrl,
    "https://github.com/TedGillXD/TouchFish/releases/tag/v1.4.0",
  );
  assert.throws(() => parseRelease({ tag_name: "v1.4.0", draft: true }));
  assert.throws(() => parseRelease({ tag_name: "v1.4.0", prerelease: true }));
});

test("manifest requires exact platform/version filenames and both valid checksums", () => {
  const parsed = parseManifest(manifest(), "1.4.0");
  assert.equal(chooseReleaseFile(parsed, "win32", "x64")?.name, file.name);
  assert.equal(chooseReleaseFile(parsed, "darwin", "x64"), null);
  assert.throws(() => parseManifest(manifest(), "1.5.0"));
  for (const patch of [
    { name: "../payload.exe" },
    { name: "CON" },
    { name: "payload.cmd" },
    { name: "TouchFish-1.3.0-win-x64-setup.exe" },
    { platform: "darwin" },
    { size: -1 },
    { size: 2 ** 32 },
    { sha256: "bad" },
    { sha512: "bad" },
  ]) {
    assert.throws(() =>
      parseManifest({ ...manifest(), files: [{ ...file, ...patch }] }, "1.4.0"),
    );
  }
  assert.throws(() =>
    parseManifest({ ...manifest(), files: [file, file] }, "1.4.0"),
  );
});

test("Linux x64 selects the canonical x86_64 AppImage filename while preserving Electron's logical architecture", () => {
  const linux = {
    ...file,
    name: "TouchFish-1.4.0-linux-x86_64.AppImage",
    platform: "linux",
    kind: "appimage",
  };
  const parsed = parseManifest({ ...manifest(), files: [linux] }, "1.4.0");
  const selected = chooseReleaseFile(parsed, "linux", "x64");
  assert.equal(selected?.name, linux.name);
  assert.equal(selected?.arch, "x64");
  assert.equal(chooseReleaseFile(parsed, "linux", "x86_64"), null);
  assert.throws(() =>
    parseManifest(
      { ...manifest(), files: [{ ...linux, arch: "x86_64" }] },
      "1.4.0",
    ),
  );
  assert.throws(() =>
    parseManifest(
      {
        ...manifest(),
        files: [{ ...linux, name: "TouchFish-1.4.0-linux-x64.AppImage" }],
      },
      "1.4.0",
    ),
  );
});

test("GitHub redirects keep verified HTTPS and never allow credentials, loopback, or executable URL schemes", () => {
  assert.equal(
    trustedUpdateUrl(
      "https://release-assets.githubusercontent.com/file?token=temporary",
    ).hostname,
    "release-assets.githubusercontent.com",
  );
  for (const url of [
    "http://github.com/TedGillXD/TouchFish",
    "https://github.com.evil.invalid/a",
    "https://user:password@github.com/a",
    "https://127.0.0.1/a",
    "https://github.com:8443/a",
    "file:///C:/payload.exe",
  ])
    assert.throws(() => trustedUpdateUrl(url));
});

test("errors never expose proxy secrets or signed download query strings", () => {
  const secret = "https://user:secret@proxy.invalid/download?token=private";
  for (const phase of ["check", "download", "install"] as const) {
    const result = safeUpdateError(new Error(secret), phase);
    assert.ok(
      !result.includes("secret") &&
        !result.includes("private") &&
        !result.includes("proxy.invalid"),
    );
  }
  assert.match(safeUpdateError(new Error("HTTP_407"), "check"), /身份验证/);
  assert.match(
    safeUpdateError(new Error("HASH_MISMATCH"), "download"),
    /校验失败/,
  );
  assert.match(
    safeUpdateError(new Error("ERR_UPDATE_TIMEOUT"), "download"),
    /超时/,
  );
  assert.match(
    safeUpdateError(new Error("SAVE_FAILED"), "install"),
    /记录尚未保存/,
  );
});

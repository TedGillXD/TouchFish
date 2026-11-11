import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIN_INSTALLER_BYTES = 1024 * 1024;
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

async function digestFile(path) {
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  for await (const chunk of createReadStream(path)) {
    sha256.update(chunk);
    sha512.update(chunk);
  }
  return { sha256: sha256.digest("hex"), sha512: sha512.digest("base64") };
}

function requiredAssets(version) {
  return [
    {
      name: `TouchFish-${version}-win-x64-setup.exe`,
      platform: "win32",
      arch: "x64",
      kind: "setup",
    },
    {
      name: `TouchFish-${version}-win-x64-portable.exe`,
      platform: "win32",
      arch: "x64",
      kind: "portable",
    },
    ...["x64", "arm64"].flatMap((arch) => [
      {
        name: `TouchFish-${version}-mac-${arch}.dmg`,
        platform: "darwin",
        arch,
        kind: "dmg",
      },
      {
        name: `TouchFish-${version}-mac-${arch}.zip`,
        platform: "darwin",
        arch,
        kind: "zip",
      },
    ]),
    {
      name: `TouchFish-${version}-linux-x86_64.AppImage`,
      platform: "linux",
      arch: "x64",
      kind: "appimage",
    },
  ];
}

/** Verify actual native build outputs before any public release is created. */
export async function verifyRelease(directory, { version, platform } = {}) {
  if (!version)
    version = JSON.parse(
      await readFile(join(root, "package.json"), "utf8"),
    ).version;
  if (!stableVersion.test(version))
    throw new Error("Invalid stable release version.");
  if (platform && !["win32", "darwin", "linux"].includes(platform))
    throw new Error("Invalid release platform.");
  const files = new Set(await readdir(directory));
  const required = requiredAssets(version).filter(
    (file) => !platform || file.platform === platform,
  );
  const digests = new Map();
  const primary = [];
  for (const asset of required) {
    if (!files.has(asset.name))
      throw new Error(`Missing installer: ${asset.name}`);
    const path = join(directory, asset.name);
    const info = await stat(path);
    if (!info.isFile() || info.size < MIN_INSTALLER_BYTES)
      throw new Error(`Installer is empty or incomplete: ${asset.name}`);
    const hashes = await digestFile(path);
    digests.set(asset.name, hashes);
    primary.push({ ...asset, size: info.size, ...hashes });
  }
  const metadata = [
    { name: "latest.yml", platform: "win32", kinds: ["setup"] },
    { name: "latest-mac.yml", platform: "darwin", kinds: ["zip", "dmg"] },
    { name: "latest-linux.yml", platform: "linux", kinds: ["appimage"] },
  ].filter((item) => !platform || item.platform === platform);
  for (const item of metadata) {
    if (!files.has(item.name))
      throw new Error(`Missing update metadata: ${item.name}`);
    const value = loadYaml(await readFile(join(directory, item.name), "utf8"));
    if (
      !value ||
      value.version !== version ||
      !Array.isArray(value.files) ||
      value.files.length === 0
    ) {
      throw new Error(`Invalid update metadata/version: ${item.name}`);
    }
    const listed = new Set();
    for (const entry of value.files) {
      if (typeof entry.url !== "string")
        throw new Error(`Missing asset URL in ${item.name}`);
      const name = decodeURIComponent(entry.url);
      if (basename(name) !== name || name.includes("\\") || !digests.has(name))
        throw new Error(`Unexpected update asset in ${item.name}: ${name}`);
      const asset = primary.find((file) => file.name === name);
      if (
        asset.platform !== item.platform ||
        entry.sha512 !== digests.get(name).sha512
      )
        throw new Error(`Update checksum/platform mismatch: ${name}`);
      if (entry.size !== undefined && entry.size !== asset.size)
        throw new Error(`Update size mismatch: ${name}`);
      listed.add(name);
    }
    for (const asset of primary.filter(
      (file) =>
        file.platform === item.platform && item.kinds.includes(file.kind),
    )) {
      if (!listed.has(asset.name))
        throw new Error(`Update metadata omits ${asset.name}`);
    }
  }
  if (!platform || platform === "win32") {
    const blockmap = `TouchFish-${version}-win-x64-setup.exe.blockmap`;
    if (
      !files.has(blockmap) ||
      (await stat(join(directory, blockmap))).size === 0
    )
      throw new Error(`Missing installer blockmap: ${blockmap}`);
  }
  if (platform) return { version, platform, files: primary };

  const manifest = { schemaVersion: 1, version, files: primary };
  await writeFile(
    join(directory, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const releaseNames = (await readdir(directory))
    .filter(
      (name) =>
        name === "release-manifest.json" ||
        metadata.some((item) => item.name === name) ||
        primary.some((file) => file.name === name) ||
        (name.startsWith(`TouchFish-${version}-`) &&
          name.endsWith(".blockmap")),
    )
    .sort();
  const checksums = [];
  for (const name of releaseNames) {
    const hashes =
      digests.get(name) || (await digestFile(join(directory, name)));
    checksums.push(`${hashes.sha256}  ${name}`);
  }
  await writeFile(join(directory, "SHA256SUMS"), `${checksums.join("\n")}\n`);
  return manifest;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const platformIndex = args.indexOf("--platform");
  const directory = resolve(args[0] || "release");
  const platform = platformIndex >= 0 ? args[platformIndex + 1] : undefined;
  const result = await verifyRelease(directory, { platform });
  console.log(
    `Verified ${result.files.length} installers for ${result.platform || "Windows, macOS and Linux"} ${result.version}.`,
  );
  if (!platform)
    console.log(
      "Generated release-manifest.json and SHA256SUMS from actual build outputs.",
    );
}

import { build } from "esbuild";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateIcons } from "./generate-icons.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export async function buildElectron() {
  await generateIcons();
  await build({
    absWorkingDir: root,
    entryPoints: { main: "electron/main.ts", preload: "electron/preload.ts" },
    outdir: "dist-electron",
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron", "electron-updater"],
    sourcemap: true,
    logLevel: "info",
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await buildElectron();

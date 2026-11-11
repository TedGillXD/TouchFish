import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { createServer } from "vite";
import { buildElectron } from "./build-electron.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await buildElectron();
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 5173, strictPort: false },
});
await server.listen();
server.printUrls();
const address = server.httpServer.address();
const env = {
  ...process.env,
  VITE_DEV_SERVER_URL: `http://127.0.0.1:${address.port}/`,
};
// Codex and other Electron hosts can set this for helper Node processes.
delete env.ELECTRON_RUN_AS_NODE;
const desktop = spawn(electron, ["."], {
  cwd: root,
  env,
  stdio: "inherit",
  windowsHide: false,
});
let stopping = false;
async function cleanup(code = 0) {
  if (stopping) return;
  stopping = true;
  if (!desktop.killed) desktop.kill();
  await server.close();
  process.exit(code);
}
desktop.on("exit", (code) => void cleanup(code || 0));
desktop.on("error", (error) => {
  console.error(error);
  void cleanup(1);
});
process.on("SIGINT", () => void cleanup());
process.on("SIGTERM", () => void cleanup());

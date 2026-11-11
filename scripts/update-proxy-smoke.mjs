import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { build } from "esbuild";
import { createHash, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer as createProxyServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { connect } from "node:net";
import { join, resolve } from "node:path";

// This test changes only an isolated Electron Session, never the OS proxy.
// A test-only certificate pin accepts the generated fixture certificate, not
// arbitrary certificates; application certificate verification remains enabled.
await mkdir(".cache", { recursive: true });
const directory = await mkdtemp(resolve(".cache/update-proxy-"));
const certificatePath = join(directory, "fixture.crt");
const keyPath = join(directory, "fixture.key");
const hosts = [
  "api.github.com",
  "github.com",
  "release-assets.githubusercontent.com",
];
const openssl =
  process.platform === "win32" &&
  existsSync("C:/Program Files/Git/usr/bin/openssl.exe")
    ? "C:/Program Files/Git/usr/bin/openssl.exe"
    : "openssl";
execFileSync(
  openssl,
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
    "-days",
    "1",
    "-subj",
    "/CN=api.github.com",
    "-addext",
    `subjectAltName=${hosts.map((host) => `DNS:${host}`).join(",")}`,
  ],
  { stdio: "ignore", windowsHide: true },
);
const certificate = await readFile(certificatePath);
const fingerprint = new X509Certificate(certificate).fingerprint256;
const version = "9.9.9";
const installerName = `TouchFish-${version}-mac-x64.dmg`;
const manifestName = "release-manifest.json";
const releasePath = `/TedGillXD/TouchFish/releases/download/v${version}`;
const latestManifestPath = `/TedGillXD/TouchFish/releases/latest/download/${manifestName}`;
const payload = Buffer.alloc(192 * 1024, 0x54);
payload.write(
  "TouchFish verified updater fixture; not an executable installer.",
);
const sha256 = createHash("sha256").update(payload).digest("hex");
const sha512 = createHash("sha512").update(payload).digest("base64");
const manifest = {
  schemaVersion: 1,
  version,
  files: [
    {
      name: installerName,
      platform: "darwin",
      arch: "x64",
      kind: "dmg",
      size: payload.length,
      sha256,
      sha512,
    },
  ],
};
let mode = "good";
const requests = [];
const tunnels = [];
const sockets = new Set();
const origin = createTlsServer(
  { key: await readFile(keyPath), cert: certificate },
  (request, response) => {
    requests.push({ host: request.headers.host, path: request.url });
    if (request.url === "/repos/TedGillXD/TouchFish/releases/latest") {
      // Old REST-based checks fail while public Release downloads stay usable.
      response.writeHead(403, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-RateLimit-Remaining": "0",
      });
      response.end(
        JSON.stringify({
          message: "API rate limit exceeded for fixture shared IP",
        }),
      );
    } else if (request.url === latestManifestPath) {
      if (mode === "offline") {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ message: "Fixture unavailable" }));
      } else {
        response.writeHead(302, {
          Location: `https://github.com${releasePath}/${manifestName}`,
        });
        response.end();
      }
    } else if (request.url === `${releasePath}/${manifestName}`) {
      response.writeHead(302, {
        Location: `https://release-assets.githubusercontent.com/${manifestName}`,
      });
      response.end();
    } else if (request.url === `/${manifestName}`) {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(manifest));
    } else if (request.url === `${releasePath}/${installerName}`) {
      response.writeHead(302, {
        Location: `https://release-assets.githubusercontent.com/${installerName}`,
      });
      response.end();
    } else if (request.url === `/${installerName}`) {
      const body =
        mode === "corrupt" ? Buffer.alloc(payload.length, 0x58) : payload;
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": body.length,
        "Cache-Control": "no-store",
      });
      response.end(body);
    } else {
      response.writeHead(404);
      response.end();
    }
  },
);
await new Promise((resolveReady) =>
  origin.listen(0, "127.0.0.1", resolveReady),
);
const originPort = origin.address().port;
const proxy = createProxyServer((_request, response) => {
  response.writeHead(400);
  response.end();
});
proxy.on("connect", (request, client, head) => {
  const host = request.url.split(":")[0];
  if (!hosts.includes(host)) {
    client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  if (mode === "proxy-auth") {
    client.end(
      'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="TouchFish fixture"\r\nContent-Length: 0\r\n\r\n',
    );
    return;
  }
  tunnels.push(host);
  const upstream = connect(originPort, "127.0.0.1", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  sockets.add(client);
  sockets.add(upstream);
  for (const socket of [client, upstream]) {
    socket.on("error", () => {
      client.destroy();
      upstream.destroy();
    });
    socket.on("close", () => sockets.delete(socket));
  }
});
await new Promise((resolveReady) => proxy.listen(0, "127.0.0.1", resolveReady));
const proxyPort = proxy.address().port;

const harness = `
import {app, BrowserWindow, session} from 'electron';
import {X509Certificate,createHash} from 'node:crypto';
import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {ElectronHttpExecutor,getNetSession} from 'electron-updater/out/electronHttpExecutor.js';
import {autoUpdater} from 'electron-updater';
import {CancellationToken,configureRequestOptionsFromUrl} from 'builder-util-runtime';
import {createUpdaterController} from './electron/updater.ts';
app.setPath('userData', process.env.TOUCHFISH_PROXY_USER_DATA);
(async()=>{
await app.whenReady();
const networkSession=getNetSession();
const proxyModes=[];
const originalSetProxy=networkSession.setProxy.bind(networkSession);
networkSession.setProxy=async(config)=>{
  proxyModes.push(config.mode);
  await originalSetProxy({mode:'fixed_servers',proxyRules:process.env.TOUCHFISH_PROXY_RULES,proxyBypassRules:'<-loopback>'});
};
networkSession.setCertificateVerifyProc((request, callback)=>{
  let matches=false;
  try{matches=${JSON.stringify(hosts)}.includes(request.hostname)&&new X509Certificate(request.certificate.data).fingerprint256===process.env.TOUCHFISH_PROXY_CERT;}catch{}
  callback(matches?0:-3);
});
let latestState;
const events=[];
let failFlush=false;
const controller=createUpdaterController({
  networkSession,currentVersion:'1.3.1',platform:'darwin',arch:'x64',packaged:true,
  onState:state=>{latestState=state;},
  beforeInstall:async()=>{events.push('flush');if(failFlush)throw new Error('Fixture save failed');},
  openInstaller:async(path)=>{events.push('open');const bytes=await readFile(path);if(bytes.length!==${payload.length}||createHash('sha256').update(bytes).digest('hex')!==${JSON.stringify(sha256)})throw new Error('Wrong installer content');return '';},
  quitForManualInstall:()=>{events.push('quit');},
});
const executor=autoUpdater.httpExecutor;
if(!(executor instanceof ElectronHttpExecutor))throw new Error('Expected actual ElectronHttpExecutor');
async function nativeCheck(){
  await networkSession.setProxy({mode:'system'});await networkSession.forceReloadProxyConfig();
  const result=await executor.request(configureRequestOptionsFromUrl(${JSON.stringify(`https://github.com${latestManifestPath}`)},{headers:{Accept:'application/json'}}),new CancellationToken());
  return JSON.parse(result).version;
}
async function nativeDownload(){
  await networkSession.setProxy({mode:'system'});await networkSession.forceReloadProxyConfig();
  await mkdir(app.getPath('userData'),{recursive:true});
  const destination=join(app.getPath('userData'),'native-fixture.dmg');
  await executor.download(new URL(${JSON.stringify(`https://github.com${releasePath}/${installerName}`)}),destination,{sha512:${JSON.stringify(sha512)},cancellationToken:new CancellationToken()});
  return createHash('sha256').update(await readFile(destination)).digest('hex');
}
globalThis.proxySmoke={controller,events,proxyModes,getState:()=>latestState,setFailFlush:value=>{failFlush=value;},nativeCheck,nativeDownload};
const window=new BrowserWindow({show:false,webPreferences:{sandbox:true}});
await window.loadURL('about:blank');
})().catch(error=>{console.error(error);app.exit(1);});
`;
const harnessPath = join(directory, "harness.cjs");
await build({
  stdin: {
    contents: harness,
    resolveDir: process.cwd(),
    sourcefile: "proxy-harness.ts",
    loader: "ts",
  },
  outfile: harnessPath,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  logLevel: "silent",
});
const env = {
  ...process.env,
  TOUCHFISH_PROXY_USER_DATA: join(directory, "user-data"),
  TOUCHFISH_PROXY_RULES: `127.0.0.1:${proxyPort}`,
  TOUCHFISH_PROXY_CERT: fingerprint,
};
delete env.ELECTRON_RUN_AS_NODE;
let desktop;
const state = () => desktop.evaluate(() => globalThis.proxySmoke.getState());
const invoke = (method) =>
  desktop.evaluate(async (_electron, name) => {
    try {
      await globalThis.proxySmoke.controller[name]();
      return { rejected: false };
    } catch (error) {
      return { rejected: true, message: String(error) };
    }
  }, method);
const phase = async () => {
  const value = await state();
  return value?.status ?? value?.phase;
};
try {
  desktop = await electron.launch({
    executablePath: electronPath,
    args: [harnessPath],
    env,
  });
  await desktop.firstWindow();
  expect(
    await desktop.evaluate(() => globalThis.proxySmoke.nativeCheck()),
  ).toBe(version);
  expect(
    await desktop.evaluate(() => globalThis.proxySmoke.nativeDownload()),
  ).toBe(sha256);
  mode = "corrupt";
  const nativeCorrupt = await desktop.evaluate(async () => {
    try {
      await globalThis.proxySmoke.nativeDownload();
      return false;
    } catch {
      return true;
    }
  });
  expect(nativeCorrupt).toBe(true);
  mode = "good";
  await invoke("check");
  await expect.poll(phase).toBe("available");
  expect(requests.some((request) => request.path === latestManifestPath)).toBe(
    true,
  );
  expect(
    requests.some(
      (request) => request.path === `${releasePath}/${manifestName}`,
    ),
  ).toBe(true);

  mode = "corrupt";
  await invoke("download");
  await expect.poll(phase).toBe("error");
  await invoke("install");
  expect(
    await desktop.evaluate(() => globalThis.proxySmoke.events.includes("open")),
  ).toBe(false);

  mode = "offline";
  await invoke("check");
  await expect.poll(phase).toBe("error");
  mode = "proxy-auth";
  await invoke("check");
  await expect.poll(phase).toBe("error");
  expect((await state()).message).toContain("代理要求身份验证");
  mode = "good";
  await invoke("check");
  await expect.poll(phase).toBe("available");
  await invoke("download");
  await expect.poll(phase).toBe("downloaded");
  expect(tunnels).toEqual(
    expect.arrayContaining(hosts.filter((host) => host !== "api.github.com")),
  );
  expect(tunnels).not.toContain("api.github.com");
  expect(
    requests.some(
      (request) =>
        request.host === "release-assets.githubusercontent.com" &&
        request.path === `/${installerName}`,
    ),
  ).toBe(true);

  await desktop.evaluate(() => globalThis.proxySmoke.setFailFlush(true));
  await invoke("install");
  expect(
    await desktop.evaluate(() => globalThis.proxySmoke.events.includes("open")),
  ).toBe(false);
  await desktop.evaluate(() => globalThis.proxySmoke.setFailFlush(false));
  await invoke("check");
  await invoke("download");
  await expect.poll(phase).toBe("downloaded");
  await invoke("install");
  expect(
    await desktop.evaluate(() => globalThis.proxySmoke.events.slice(-3)),
  ).toEqual(["flush", "open", "quit"]);
  const modes = await desktop.evaluate(() => globalThis.proxySmoke.proxyModes);
  expect(modes.length).toBeGreaterThanOrEqual(6);
  expect(modes.every((value) => value === "system")).toBe(true);
  expect(
    requests.some(
      (request) =>
        request.path === "/repos/TedGillXD/TouchFish/releases/latest",
    ),
  ).toBe(false);
  console.log(
    "PASS: API-free Release checks despite a REST-403 fixture; real Electron system proxy and ElectronHttpExecutor, HTTPS CONNECT manifest/binary redirects, native/manual checksum rejection, authentication/error retry and save-before-install ordering; no OS proxy or installed application changed.",
  );
  await writeFile(
    join(directory, "report.json"),
    JSON.stringify({ modes, tunnels, requests }, null, 2),
  );
} catch (error) {
  console.error(
    "Proxy fixture diagnostic:",
    JSON.stringify({
      state: desktop ? await state().catch(() => null) : null,
      tunnels,
      requests,
    }),
  );
  throw error;
} finally {
  await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await desktop?.close().catch(() => {});
  for (const socket of sockets) socket.destroy();
  await Promise.all([
    new Promise((resolveClosed) => proxy.close(resolveClosed)),
    new Promise((resolveClosed) => origin.close(resolveClosed)),
  ]);
}

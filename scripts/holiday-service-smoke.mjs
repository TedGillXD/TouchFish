import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { build } from "esbuild";
import { X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rmdir, writeFile } from "node:fs/promises";
import { createServer as createProxyServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { connect } from "node:net";
import { join, resolve } from "node:path";

// Only this isolated Session uses the fixture proxy/certificate. OS proxy and
// application TLS verification are never changed.
await mkdir(".cache", { recursive: true });
const directory = await mkdtemp(resolve(".cache/holiday-service-"));
const fixture = JSON.parse(await readFile("tests/fixtures/china-holidays.json", "utf8"));
const keyPath = join(directory, "fixture.key");
const certificatePath = join(directory, "fixture.crt");
const hosts = ["raw.githubusercontent.com", "cdn.jsdelivr.net"];
const openssl = process.platform === "win32" && existsSync("C:/Program Files/Git/usr/bin/openssl.exe")
  ? "C:/Program Files/Git/usr/bin/openssl.exe" : "openssl";
execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath,
  "-out", certificatePath, "-days", "1", "-subj", "/CN=raw.githubusercontent.com", "-addext",
  `subjectAltName=${hosts.map((host) => `DNS:${host}`).join(",")}`], { stdio: "ignore", windowsHide: true });
const certificate = await readFile(certificatePath);
const fingerprint = new X509Certificate(certificate).fingerprint256;
const sockets = new Set();
const requests = [];
const tunnels = [];
let mode = "placeholder";
const origin = createTlsServer({ key: await readFile(keyPath), cert: certificate }, (request, response) => {
  const host = request.headers.host;
  requests.push({ host, path: request.url });
  const matched = /\/(\d{4})\.json$/.exec(request.url);
  const year = Number(matched?.[1]);
  const data = fixture.find((value) => value.year === year);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json");
  if (!data) { response.writeHead(404); response.end(); }
  else if (mode === "offline" || mode === "fallback" && host === hosts[0]) { response.writeHead(503); response.end(); }
  else if (mode === "redirect") { response.writeHead(302, { Location: "https://untrusted.example/secret" }); response.end(); }
  else if (mode === "oversize") { response.writeHead(200); response.write(Buffer.alloc(256 * 1024 + 1, 0x20)); response.end(); }
  else if (mode === "hang") { response.writeHead(200); response.write("{"); }
  else if (mode === "invalid") { response.end(JSON.stringify({ ...data, year: 1999 })); }
  else if (mode === "placeholder" && year === 2027) { response.end(JSON.stringify({ year, papers: [], days: [] })); }
  else response.end(JSON.stringify(data));
});
await new Promise((ready) => origin.listen(0, "127.0.0.1", ready));
const originPort = origin.address().port;
const proxy = createProxyServer((_request, response) => { response.writeHead(400); response.end(); });
proxy.on("connect", (request, client, head) => {
  const host = request.url.split(":")[0];
  if (!hosts.includes(host)) { client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
  if (mode === "proxy-auth") {
    client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Holiday fixture"\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  tunnels.push(host);
  const upstream = connect(originPort, "127.0.0.1", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    client.pipe(upstream); upstream.pipe(client);
  });
  for (const socket of [client, upstream]) {
    sockets.add(socket);
    socket.on("error", () => { client.destroy(); upstream.destroy(); });
    socket.on("close", () => sockets.delete(socket));
  }
});
await new Promise((ready) => proxy.listen(0, "127.0.0.1", ready));

const harness = `
import {app, BrowserWindow, session} from 'electron';
import {X509Certificate} from 'node:crypto';
import {createHolidayService} from './electron/holiday-service.ts';
import {getHolidayYears,getPublicHoliday} from './src/holidays.ts';
app.setPath('userData', process.env.TOUCHFISH_HOLIDAY_USER_DATA);
(async()=>{
await app.whenReady();
const networkSession=session.fromPartition('holiday-fixture',{cache:false});
const proxyModes=[];
const original=networkSession.setProxy.bind(networkSession);
networkSession.setProxy=async(config)=>{
  proxyModes.push(config.mode);
  await original({mode:'fixed_servers',proxyRules:process.env.TOUCHFISH_HOLIDAY_PROXY,proxyBypassRules:'<-loopback>'});
};
networkSession.setCertificateVerifyProc((request,callback)=>{
  let matches=false;
  try { matches=${JSON.stringify(hosts)}.includes(request.hostname)&&new X509Certificate(request.certificate.data).fingerprint256===process.env.TOUCHFISH_HOLIDAY_CERT; }catch{}
  callback(matches?0:-3);
});
let timestamp=new Date('2026-11-11T10:00:00').getTime();
const events=[];
let service;
async function create(){service=await createHolidayService({networkSession,now:()=>timestamp,requestTimeoutMs:250,onState:state=>events.push(state.status)});}
await create();
globalThis.holidayTest={
  refresh:(years,force)=>service.refresh(years,force),get:()=>service.getState(),
  restart:async()=>{service.dispose();await create();return service.getState();},
  start:()=>service.start(),advance:delta=>{timestamp+=delta;},
  coverage:()=>({years:getHolidayYears(),day:getPublicHoliday('2026-10-01')}),
  flush:()=>service.flush(),proxyModes,events,
  flushDuringRequest:async()=>{const refresh=service.refresh([2026],true);const begun=Date.now();await service.flush();const elapsed=Date.now()-begun;service.dispose();await refresh;return elapsed;},
};
const window=new BrowserWindow({show:false,webPreferences:{sandbox:true}});
await window.loadURL('about:blank');
})().catch(error=>{console.error(error);app.exit(1);});
`;
const harnessPath = join(directory, "harness.cjs");
await build({ stdin: { contents: harness, resolveDir: process.cwd(), sourcefile: "holiday-service-harness.ts", loader: "ts" },
  outfile: harnessPath, bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"], logLevel: "silent" });
const userData = join(directory, "user-data");
const env = { ...process.env, TOUCHFISH_HOLIDAY_USER_DATA: userData,
  TOUCHFISH_HOLIDAY_PROXY: `127.0.0.1:${proxy.address().port}`, TOUCHFISH_HOLIDAY_CERT: fingerprint,
  TOUCHFISH_HOLIDAYS_AUTO_REFRESH: "0" };
delete env.ELECTRON_RUN_AS_NODE;
let desktop;
const get = () => desktop.evaluate(() => globalThis.holidayTest.get());
const refresh = (years, force = false) => desktop.evaluate(async (_electron, { years, force }) => globalThis.holidayTest.refresh(years, force), { years, force });
try {
  desktop = await electron.launch({ executablePath: electronPath, args: [harnessPath], env });
  await desktop.firstWindow();
  expect((await get()).years).toEqual([]);
  await desktop.evaluate(() => globalThis.holidayTest.start());
  expect(requests).toHaveLength(0);

  const unpublished = await refresh([2027]);
  expect(unpublished.status).toBe("idle");
  expect(unpublished.years).toEqual([]);
  expect(unpublished.message).toContain("尚未公布");
  const initial = await refresh([2026, 2027], true);
  expect(initial.status).toBe("ready");
  expect(initial.years.map((value) => value.year)).toEqual([2026]);
  expect(initial.message).toContain("尚未公布");
  expect(await desktop.evaluate(() => globalThis.holidayTest.coverage())).toEqual({ years: [2026], day: { kind: "rest", name: "国庆节" } });
  const count = requests.length;
  await Promise.all([refresh([2026]), refresh([2026])]);
  expect(requests).toHaveLength(count);

  mode = "fallback";
  const fallback = await refresh([2027], true);
  expect(fallback.status).toBe("ready");
  expect(fallback.years.map((value) => value.year)).toEqual([2026, 2027]);
  expect(fallback.years[1].source).toContain("cdn.jsdelivr.net");
  const verified = fallback.years;

  for (mode of ["invalid", "redirect", "oversize", "offline", "proxy-auth", "hang"]) {
    const result = await refresh([2026], true);
    expect(result.status, mode).toBe("error");
    expect(result.years, mode).toEqual(verified);
  }
  expect(tunnels.every((host) => hosts.includes(host))).toBe(true);

  const restored = await desktop.evaluate(() => globalThis.holidayTest.restart());
  expect(restored.years).toEqual(verified);
  const previousCount = requests.length;
  await refresh([2026]);
  expect(requests).toHaveLength(previousCount);
  mode = "good";
  await desktop.evaluate(() => globalThis.holidayTest.advance(86_400_000));
  expect((await refresh([2026])).status).toBe("ready");
  expect(requests.length).toBeGreaterThan(previousCount);

  // A disk failure never truncates the last verified primary cache.
  const cachePath = join(userData, "holiday-cache.json");
  const previousCache = await readFile(cachePath, "utf8");
  const obstructed = join(userData, "holiday-cache.tmp.json");
  await mkdir(obstructed);
  try {
    const unsaved = await refresh([2026], true);
    expect(unsaved.status).toBe("error");
    expect(unsaved.message).toContain("缓存保存失败");
    expect(await readFile(cachePath, "utf8")).toBe(previousCache);
  } finally { await rmdir(obstructed); }
  expect((await refresh([2026], true)).status).toBe("ready");

  await writeFile(join(userData, "holiday-cache.json"), "{broken cache", "utf8");
  const recovery = await desktop.evaluate(() => globalThis.holidayTest.restart());
  expect(recovery.years).toHaveLength(2);
  expect(await readFile(join(userData, "holiday-cache.invalid.json"), "utf8")).toBe("{broken cache");
  expect(recovery.message).toContain("备用");
  mode = "good";
  const beforeDedupe = requests.length;
  await Promise.all([refresh([2026], true), refresh([2026], true)]);
  expect(requests.length - beforeDedupe).toBe(1);
  const disk = JSON.parse(await readFile(join(userData, "holiday-cache.json"), "utf8"));
  expect(disk.country).toBe("CN");
  expect(disk.years).toHaveLength(2);

  mode = "hang";
  const elapsed = await desktop.evaluate(() => globalThis.holidayTest.flushDuringRequest());
  expect(elapsed).toBeLessThan(1000);
  const proxyModes = await desktop.evaluate(() => globalThis.holidayTest.proxyModes);
  expect(proxyModes.length).toBeGreaterThan(5);
  expect(proxyModes.every((value) => value === "system")).toBe(true);
  console.log("PASS: real Electron system-proxy CONNECT downloads, raw/CDN fallback, unpublished years, 24h freshness, in-flight deduplication, schema/redirect/size/auth/timeout failures, verified cache preservation/restart/recovery and nonblocking shutdown.");
} catch (error) {
  console.error("Holiday fixture diagnostic:", JSON.stringify({ state: desktop ? await get().catch(() => null) : null, requests, tunnels }));
  throw error;
} finally {
  await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await desktop?.close().catch(() => {});
  for (const socket of sockets) socket.destroy();
  await Promise.all([new Promise((closed) => proxy.close(closed)), new Promise((closed) => origin.close(closed))]);
}

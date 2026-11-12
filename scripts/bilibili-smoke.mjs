import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { join, resolve } from "node:path";
import { seedHolidayCache } from "./test-holiday-cache.mjs";

// The complete app uses an isolated account store and test-only HTTPS handlers.
// API and original synthetic media stay local; OS proxy and TLS are untouched.
await mkdir(".cache", { recursive: true });
const directory = await mkdtemp(resolve(".cache/bilibili-ui-"));
const userData = join(directory, "user-data");
await mkdir(userData, { recursive: true });
await seedHolidayCache(userData);
const harnessPath = join(directory, "bilibili-harness.cjs");
const keyPath = join(directory, "fixture.key"), certificatePath = join(directory, "fixture.crt");
const hosts = ["api.bilibili.com", "passport.bilibili.com", "upos-fixture.bilivideo.com", "i0.hdslb.com"];
const openssl = process.platform === "win32" && existsSync("C:/Program Files/Git/usr/bin/openssl.exe") ? "C:/Program Files/Git/usr/bin/openssl.exe" : "openssl";
execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certificatePath,
  "-days", "1", "-subj", "/CN=api.bilibili.com", "-addext", `subjectAltName=${hosts.map(host => `DNS:${host}`).join(",")}`], { stdio: "ignore", windowsHide: true });
const fingerprint = new X509Certificate(await readFile(certificatePath)).fingerprint256;
await writeFile(harnessPath, `
const {app,session}=require('electron');
const {readFileSync}=require('node:fs');
const {createServer:httpsServer}=require('node:https');
const {createServer:proxyServer}=require('node:http');
const {connect}=require('node:net');
const {X509Certificate}=require('node:crypto');
app.setPath('userData',process.env.TOUCHFISH_USER_DATA);
const video=readFileSync(${JSON.stringify(resolve("tests/fixtures/bili-video.webm"))});
const audio=readFileSync(${JSON.stringify(resolve("tests/fixtures/bili-audio.wav"))});
const pixel=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
let qr='waiting',media='good';const requests=[];
globalThis.biliFixture={setQr:value=>{qr=value;},setMedia:value=>{media=value;},requests};
const fixtureReady=app.whenReady().then(async()=>{
 const network=session.fromPartition('persist:touchfish-bilibili',{cache:false});
 const handleFixture=async request=>{
  const url=new URL(request.url),path=url.pathname;
  requests.push({host:url.hostname,path,range:request.headers.get('range'),referer:request.headers.get('referer'),hasCookie:request.headers.has('cookie')});
  const json=(data,headers={})=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json','Cache-Control':'no-store',...headers}});
  if(url.hostname==='passport.bilibili.com'){
   if(path.endsWith('/generate'))return json({code:0,data:{url:'https://account.bilibili.com/h5/account-h5/auth/scan-web?qrcode_key=fixture-qr-key-not-real',qrcode_key:'fixture-qr-key-not-real'}});
   if(path.endsWith('/poll')){
    if(qr==='expired')return json({code:0,data:{code:86038}});
    if(qr==='scanned')return json({code:0,data:{code:86090}});
    if(qr==='confirmed')return json({code:0,data:{code:0}},{'Set-Cookie':'SESSDATA=fixture-only-not-a-real-session; Domain=.bilibili.com; Path=/; Secure; HttpOnly; Max-Age=86400'});
    return json({code:0,data:{code:86101}});
   }
  }
  if(url.hostname==='api.bilibili.com'){
   if(path==='/x/web-interface/nav'){
    const loggedIn=request.headers.get('cookie')?.includes('SESSDATA=fixture-only-not-a-real-session');
    return json({code:loggedIn?0:-101,data:{isLogin:loggedIn,mid:12345,uname:'演示用户',face:'https://i0.hdslb.com/bili-fixture.png',wbi_img:{img_url:'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'}}});
   }
   if(path==='/x/web-interface/view'){
    const bvid=url.searchParams.get('bvid');
    if(bvid!=='BV17x411w7KC')return json({code:-404,message:'video unavailable'});
    return json({code:0,data:{bvid,title:'TouchFish · B站播放演示',pic:'https://i0.hdslb.com/bili-fixture.png',duration:40,owner:{name:'TouchFish 演示'},pages:[{cid:101,page:1,part:'第一段',duration:20},{cid:102,page:2,part:'第二段',duration:20}]}});
   }
   if(path==='/x/player/wbi/playurl'){
    if(!url.searchParams.has('w_rid')||!url.searchParams.has('wts'))return json({code:-403,message:'missing WBI'});
    const cid=url.searchParams.get('cid'),qn=Number(url.searchParams.get('qn'));
    return json({code:0,data:{quality:qn===16?16:80,accept_quality:[80,16],accept_description:['1080P','360P'],dash:{duration:20,video:[80,16].map(id=>({id,codecid:7,codecs:'avc1.64001e',mimeType:'video/mp4',baseUrl:'https://upos-fixture.bilivideo.com/video-'+cid+'-'+id+'.webm'})),audio:[{id:30280,codecs:'mp4a.40.2',mimeType:'audio/mp4',bandwidth:10000,baseUrl:'https://upos-fixture.bilivideo.com/audio-'+cid+'.wav'}]}}});
   }
   if(path==='/x/v1/dm/list.so')return new Response('<?xml version="1.0" encoding="UTF-8"?><i><d p="0.1,1,25,16777215,1,0,0,1">摸鱼时钟演示弹幕</d><d p="5,5,25,65280,1,0,0,2">&lt;img src=x onerror=alert(1)&gt;</d></i>',{headers:{'Content-Type':'text/xml'}});
  }
  if(url.hostname==='i0.hdslb.com')return new Response(pixel,{headers:{'Content-Type':'image/png'}});
  if(url.hostname==='upos-fixture.bilivideo.com'){
   if(media==='forbidden')return new Response('',{status:403});
   const body=path.startsWith('/audio-')?audio:video;
   const type=path.startsWith('/audio-')?'audio/wav':'video/webm';
   const range=request.headers.get('range');const match=/^bytes=(\\d+)-(\\d*)$/.exec(range||'');
   const start=match?Number(match[1]):0,end=match&&match[2]?Math.min(body.length-1,Number(match[2])):body.length-1;
   if(start>=body.length)return new Response('',{status:416,headers:{'Content-Range':'bytes */'+body.length}});
   return new Response(request.method==='HEAD'?null:body.subarray(start,end+1),{status:match?206:200,headers:{'Content-Type':type,'Content-Length':String(end-start+1),'Accept-Ranges':'bytes','Cache-Control':'no-store',...(match?{'Content-Range':'bytes '+start+'-'+end+'/'+body.length}:{})}});
  }
  return new Response('',{status:404});
 };
 const origin=httpsServer({key:readFileSync(${JSON.stringify(keyPath)}),cert:readFileSync(${JSON.stringify(certificatePath)})},async(incoming,outgoing)=>{
  try{
   const result=await handleFixture(new Request('https://'+incoming.headers.host+incoming.url,{method:incoming.method,headers:incoming.headers}));
   const headers=Object.fromEntries(result.headers),cookies=result.headers.getSetCookie();
   if(cookies.length)headers['set-cookie']=cookies;
   outgoing.writeHead(result.status,headers);outgoing.end(incoming.method==='HEAD'?undefined:Buffer.from(await result.arrayBuffer()));
  }catch{outgoing.writeHead(500);outgoing.end();}
 });
 await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));
 const proxy=proxyServer();
 proxy.on('connect',(request,client,head)=>{
  if(!${JSON.stringify(hosts)}.includes(request.url.split(':')[0])){client.end('HTTP/1.1 403 Forbidden\\r\\n\\r\\n');return;}
  const upstream=connect(origin.address().port,'127.0.0.1',()=>{
   client.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);
  });
  upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());client.on('close',()=>upstream.destroy());
 });
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 network.setCertificateVerifyProc((request,callback)=>callback(${JSON.stringify(hosts)}.includes(request.hostname)&&new X509Certificate(request.certificate.data).fingerprint256===${JSON.stringify(fingerprint)}?0:request.errorCode));
 const setProxy=network.setProxy.bind(network);
 network.setProxy=async()=>setProxy({mode:'fixed_servers',proxyRules:'http=127.0.0.1:'+proxy.address().port+';https=127.0.0.1:'+proxy.address().port,proxyBypassRules:'<-loopback>'});
 session.fromPartition('touchfish-holidays',{cache:false}).protocol.handle('https',()=>new Response('',{status:503}));
}).catch(error=>{console.error(error);app.exit(1);});
app.whenReady=()=>fixtureReady;
require(${JSON.stringify(resolve("dist-electron/main.cjs"))});
`, "utf8");

const env = { ...process.env, TOUCHFISH_USER_DATA: userData, TOUCHFISH_KEEP_OPEN: "1", TOUCHFISH_HOLIDAYS_AUTO_REFRESH: "0" };
delete env.ELECTRON_RUN_AS_NODE;
let desktop;
let main;
let player;
const errors = [];
async function launch() {
  desktop = await electron.launch({ executablePath: electronPath, args: [harnessPath], env });
  await expect.poll(() => desktop.windows().some(page => page.url().endsWith("/index.html")), { timeout: 15000 }).toBe(true);
  main = desktop.windows().find(page => page.url().endsWith("/index.html"));
  main.setDefaultTimeout(15000);
  main.on("pageerror", error => errors.push(error.message));
  await expect(main.getByText("今日已赚", { exact: true })).toBeVisible();
  await main.getByRole("button", { name: "摸鱼", exact: true }).click();
  await expect(main.getByRole("heading", { name: "摸鱼 · B 站", exact: true })).toBeVisible();
}
async function close() {
  await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await desktop?.close().catch(() => {});
  desktop = undefined;
}
async function quitNormally() {
  const closed = desktop.waitForEvent("close", { timeout: 15000 });
  await main.evaluate(() => window.touchFish.quit());
  await closed;
  desktop = undefined;
}
const fixture = (key, value) => desktop.evaluate((_electron, { key, value }) => globalThis.biliFixture[key](value), { key, value });
const media = () => player.evaluate(() => ({
  video: { ready: document.querySelector("video").readyState, time: document.querySelector("video").currentTime, paused: document.querySelector("video").paused, muted: document.querySelector("video").muted, source: document.querySelector("video").getAttribute("src"), rate: document.querySelector("video").playbackRate },
  audio: { ready: document.querySelector("audio").readyState, time: document.querySelector("audio").currentTime, paused: document.querySelector("audio").paused, muted: document.querySelector("audio").muted, source: document.querySelector("audio").getAttribute("src"), rate: document.querySelector("audio").playbackRate },
}));
async function playing(mode) {
  await expect.poll(async () => { const value = await media(); return mode === "video" ? value.video.ready >= 2 && value.audio.ready >= 2 && !value.video.paused && !value.audio.paused : value.audio.ready >= 2 && !value.audio.paused && !value.video.source; }, { timeout: 15000 }).toBe(true);
}
async function hover() {
  const size = player.viewportSize() ?? await player.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await player.mouse.move(size.width / 2, size.height / 2);
}
async function openPlayer(mode) {
  await main.getByRole("button", { name: mode === "video" ? "看视频" : "听视频", exact: true }).click();
  await expect.poll(() => desktop.windows().some(page => page.url().includes("window=player")), { timeout: 15000 }).toBe(true);
  player = desktop.windows().find(page => page.url().includes("window=player"));
  player.setDefaultTimeout(15000);
  player.on("pageerror", error => errors.push(error.message));
  await expect(player.locator(".bili-player")).toBeVisible();
}
async function closePlayer() {
  const closed = player.waitForEvent("close");
  // Native close can destroy the CDP target before the click acknowledgement.
  await player.getByRole("button", { name: "关闭播放器", exact: true }).click().catch(error => { if (!player.isClosed()) throw error; });
  await closed;
  await expect.poll(() => desktop.windows().some(page => page.url().includes("window=player"))).toBe(false);
}

try {
  await launch();
  console.log("Checking generated QR, expiry, scan confirmation and isolated login persistence...");
  await main.getByRole("button", { name: "获取二维码", exact: true }).click();
  await expect(main.getByAltText("B站扫码登录二维码")).toBeVisible();
  expect(await main.getByAltText("B站扫码登录二维码").evaluate(image => image.complete && image.naturalWidth >= 200)).toBe(true);
  await main.screenshot({ path: "docs/bilibili-panel.png", scale: "css" });
  await fixture("setQr", "expired");
  await expect(main.locator(".bili-auth-message")).toContainText("过期");
  await fixture("setQr", "waiting");
  await main.getByRole("button", { name: "获取二维码", exact: true }).click();
  await fixture("setQr", "scanned");
  await expect(main.locator(".bili-auth-message")).toContainText("手机端确认");
  await fixture("setQr", "confirmed");
  await expect(main.locator(".bili-account-name")).toContainText("演示用户");
  expect(await main.evaluate(async () => JSON.stringify(await window.touchFish.bilibili.getAuth()).includes("fixture-only"))).toBe(false);
  await quitNormally();
  await launch();
  await expect(main.locator(".bili-account-name")).toContainText("演示用户");

  console.log("Checking BV validation, metadata and decoded separate video/audio streams...");
  const input = main.getByLabel("BV号或视频链接", { exact: true });
  await input.fill("not-a-bv");
  await main.getByRole("button", { name: "查找视频", exact: true }).click();
  await expect(main.locator(".bili-panel-error")).toContainText("BV");
  await input.fill("BV1xx411c7mD");
  await main.getByRole("button", { name: "查找视频", exact: true }).click();
  await expect(main.locator(".bili-panel-error")).toContainText("视频");
  await input.fill("https://www.bilibili.com/video/BV17x411w7KC");
  await main.getByRole("button", { name: "查找视频", exact: true }).click();
  await expect(main.locator(".bili-video-info")).toContainText("TouchFish · B站播放演示");
  await openPlayer("video");
  await playing("video");
  await expect.poll(async () => (await media()).video.time).toBeGreaterThan(0.4);
  let value = await media();
  expect(value.video.muted).toBe(true);
  expect(value.audio.muted).toBe(false);
  expect(Math.abs(value.video.time - value.audio.time)).toBeLessThan(0.5);
  expect(value.video.source).toMatch(/^touchfish-media:\/\/stream\//);
  console.log("Checking stalled network notifications do not pause buffered playback...");
  await expect.poll(async () => { const tracks = await media(); return tracks.video.ready >= 3 && tracks.audio.ready >= 3; }).toBe(true);
  const beforeStalled = await media();
  await player.evaluate(() => {
    document.querySelector("video").dispatchEvent(new Event("stalled"));
    document.querySelector("audio").dispatchEvent(new Event("stalled"));
  });
  await expect.poll(async () => { const tracks = await media(); return !tracks.video.paused && !tracks.audio.paused && tracks.video.time > beforeStalled.video.time + 0.2 && tracks.audio.time > beforeStalled.audio.time + 0.2; }).toBe(true);
  const native = await desktop.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes("window=player"));
    window.setSize(800, 450);
    return { onTop: window.isAlwaysOnTop(), resizable: window.isResizable(), minimum: window.getMinimumSize(), bounds: window.getBounds() };
  });
  expect(native.onTop).toBe(false);
  expect(native.resizable).toBe(true);
  expect(native.minimum).toEqual([320, 180]);
  // Windows converts physical pixels through fractional display scaling.
  expect(Math.abs(native.bounds.width - 800)).toBeLessThanOrEqual(1);
  expect(Math.abs(native.bounds.height - 450)).toBeLessThanOrEqual(1);

  console.log("Checking hover controls, pause, seeking, rate, quality, parts and danmaku...");
  await player.evaluate(() => document.activeElement?.blur());
  await player.mouse.move(-20, -20);
  await expect(player.locator(".bili-player-bottom")).toHaveCSS("opacity", "0");
  await hover();
  await expect(player.locator(".bili-player-bottom")).toHaveCSS("opacity", "1");
  await player.getByRole("button", { name: "暂停播放", exact: true }).click();
  await expect.poll(async () => { const tracks = await media(); return tracks.video.paused && tracks.audio.paused; }).toBe(true);
  const stoppedTime = (await media()).video.time;
  await new Promise(resolve => setTimeout(resolve, 350));
  expect(Math.abs((await media()).video.time - stoppedTime)).toBeLessThan(0.12);
  await player.getByLabel("播放进度", { exact: true }).fill("5");
  await expect.poll(async () => (await media()).video.time).toBeCloseTo(5, 0);
  await player.getByLabel("播放速度", { exact: true }).selectOption("2");
  value = await media();
  expect(value.video.rate).toBe(2);
  expect(value.audio.rate).toBe(2);
  await player.getByRole("button", { name: "播放", exact: true }).click();
  await playing("video");
  const beforeQuality = (await media()).video.time;
  await player.getByLabel("清晰度", { exact: true }).selectOption("16");
  await expect.poll(() => player.evaluate(async () => (await window.touchFish.bilibili.getPlayback()).quality)).toBe(16);
  await playing("video");
  expect((await media()).video.time).toBeGreaterThanOrEqual(beforeQuality - 0.3);
  await player.getByLabel("切换分P", { exact: true }).selectOption("102");
  await expect.poll(() => player.evaluate(async () => (await window.touchFish.bilibili.getPlayback()).cid)).toBe(102);
  await playing("video");
  expect((await media()).video.time).toBeLessThan(4);
  const danmakuButton = player.getByRole("button", { name: "打开弹幕", exact: true });
  if (await danmakuButton.count()) await danmakuButton.click();
  await expect(player.getByRole("button", { name: "关闭弹幕", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => desktop.evaluate(() => globalThis.biliFixture.requests.some(request => request.path === "/x/v1/dm/list.so"))).toBe(true);
  await player.getByRole("button", { name: "关闭弹幕", exact: true }).click();
  await expect(player.getByRole("button", { name: "打开弹幕", exact: true })).toHaveAttribute("aria-pressed", "false");
  await hover();
  await player.screenshot({ path: "docs/bilibili-player.png", scale: "css" });

  console.log("Checking audio-only mode, protected payroll IPC and stream failures/retry...");
  const beforeMode = (await media()).video.time;
  await player.getByRole("button", { name: "只听音频", exact: true }).click();
  await playing("audio");
  expect((await media()).audio.time).toBeGreaterThanOrEqual(beforeMode - 0.3);
  expect((await media()).video.paused).toBe(true);
  await player.getByRole("button", { name: "最小化播放器", exact: true }).click();
  const minimized = () => desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes("window=player"))?.isMinimized());
  await expect.poll(minimized).toBe(true);
  await player.evaluate(async () => {
    const playback = await window.touchFish.bilibili.getPlayback();
    await window.touchFish.bilibili.play({ bvid: playback.video.bvid, mode: playback.mode, cid: playback.cid, quality: 16 });
  });
  await playing("audio");
  expect(await minimized()).toBe(true);
  const minimizedTime = (await media()).audio.time;
  await expect.poll(async () => (await media()).audio.time).toBeGreaterThan(minimizedTime + 0.2);
  await main.evaluate(() => window.touchFish.bilibili.showPlayer());
  await expect.poll(minimized).toBe(false);
  await hover();
  expect(await player.evaluate(async () => {
    const denied = async callback => { try { await callback(); return false; } catch { return true; } };
    return { save: await denied(() => window.touchFish.saveData({})), update: await denied(() => window.touchFish.updater.check()) };
  })).toEqual({ save: true, update: true });
  await player.getByRole("button", { name: "切换到视频", exact: true }).click();
  await playing("video");
  await closePlayer();
  await fixture("setMedia", "forbidden");
  await openPlayer("video");
  await expect(player.locator(".bili-player-error")).toBeVisible({ timeout: 20000 });
  await fixture("setMedia", "good");
  await player.getByRole("button", { name: "重试播放", exact: true }).click();
  await playing("video");
  await hover();
  await closePlayer();
  await main.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(main.getByRole("button", { name: "获取二维码", exact: true })).toBeVisible();
  expect(await desktop.evaluate(async ({ session }) => (await session.fromPartition("persist:touchfish-bilibili").cookies.get({ domain: "bilibili.com" })).length)).toBe(0);
  const requests = await desktop.evaluate(() => globalThis.biliFixture.requests);
  const cdn = requests.filter(request => request.host === "upos-fixture.bilivideo.com");
  expect(cdn.some(request => request.range)).toBe(true);
  expect(cdn.every(request => request.referer === "https://www.bilibili.com/" && !request.hasCookie)).toBe(true);
  expect(errors).toEqual([]);
  console.log("PASS: QR login states/persistence/logout, BV lookup, decoded split playback, range/referrer, buffered stalled events, resize/non-topmost window, hover controls, pause/seek/rate/quality/parts, danmaku, audio-only/minimized playback, protected IPC and media failure recovery.");
  console.log(`Isolated data: ${userData}`);
} finally {
  await close();
}

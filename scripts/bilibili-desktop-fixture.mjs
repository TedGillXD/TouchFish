import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { join, resolve } from "node:path";
import { seedHolidayCache } from "./test-holiday-cache.mjs";


/** Shared native TLS fixture; no OS proxy, real accounts, or downloaded media. */
export async function createBilibiliDesktopFixture({ prefix = ".cache/bilibili-ui-", mainSetup = "" } = {}) {
// The complete app uses an isolated account store and test-only HTTPS handlers.
// API and original synthetic media stay local; OS proxy and TLS are untouched.
await mkdir(".cache", { recursive: true });
const directory = await mkdtemp(resolve(prefix));
const userData = join(directory, "user-data");
await mkdir(userData, { recursive: true });
await seedHolidayCache(userData);
// Keep the wage clock running while transport is paused. This is unrelated to
// media time: changing video playback must never pause work accrual.
const realToday = new Date();
const workDate = `${realToday.getFullYear()}-${String(realToday.getMonth() + 1).padStart(2, "0")}-${String(realToday.getDate()).padStart(2, "0")}`;
await writeFile(join(userData, "state.json"), JSON.stringify({ version: 1, records: {}, settings: {
  monthlySalary: 21000, publicHolidays: false,
  weekdayHours: Object.fromEntries(Array.from({ length: 7 }, (_, weekday) => [weekday, { start: "00:00", end: "23:59" }])),
  lunch: { enabled: false, start: "12:00", end: "13:00" },
  dinner: { enabled: false, start: "18:00", end: "19:00" },
  overrides: { [workDate]: "work" },
} }));
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
let qr='waiting',media='good',delayPlay=false;const requests=[],playReleases=[];
globalThis.biliFixture={setQr:value=>{qr=value;},setMedia:value=>{media=value;},setPlayDelay:value=>{delayPlay=value;},releasePlay:()=>{delayPlay=false;for(const release of playReleases.splice(0))release();},get playPending(){return playReleases.length;},requests};
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
    if(delayPlay)await new Promise(resolve=>playReleases.push(resolve));
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
${mainSetup}
require(${JSON.stringify(resolve("dist-electron/main.cjs"))});
`, "utf8");


return { directory, userData, harnessPath, workDate };
}

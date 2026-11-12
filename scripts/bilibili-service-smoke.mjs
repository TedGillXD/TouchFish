import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { build } from "esbuild";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import { join, resolve } from "node:path";

await mkdir(".cache", { recursive: true });
const directory = await mkdtemp(resolve(".cache/bili-service-"));
const harness = join(directory, "harness.cjs");
const keyPath = join(directory, "fixture.key"), certificatePath = join(directory, "fixture.crt");
const hosts = ["api.bilibili.com", "passport.bilibili.com", "upos-fixture.bilivideo.com", "peer.mcdn.bilivideo.cn", "i0.hdslb.com"];
const openssl = process.platform === "win32" && existsSync("C:/Program Files/Git/usr/bin/openssl.exe") ? "C:/Program Files/Git/usr/bin/openssl.exe" : "openssl";
execFileSync(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certificatePath,
  "-days", "1", "-subj", "/CN=api.bilibili.com", "-addext", `subjectAltName=${hosts.map(host => `DNS:${host}`).join(",")}`], { stdio: "ignore", windowsHide: true });
const fingerprint = new X509Certificate(await readFile(certificatePath)).fingerprint256;
await build({
  stdin: { contents: `
    import {app, BrowserWindow, protocol, session} from 'electron';
    import {createBilibiliService} from './electron/bilibili-service';
    import {readFileSync} from 'node:fs';
    import {createServer as httpsServer} from 'node:https';
    import {createServer as proxyServer} from 'node:http';
    import {connect} from 'node:net';
    import {X509Certificate} from 'node:crypto';
    app.setPath('userData', process.env.TOUCHFISH_USER_DATA);
    protocol.registerSchemesAsPrivileged([{scheme:'touchfish-media',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
    let mode='good', login='waiting', qrAddress='current', clock=Date.now(), key=0, navRemaining=0, releaseNav=null;
    const requests=[];
    const uid=456;
    const bvid='BV1xx411c7mD';
    function response(value,status=200,headers={}) { return new Response(status===204?null:JSON.stringify(value),{status,headers:{'Content-Type':'application/json',...headers}}); }
    function nav(request) {
      const logged=request.headers.get('cookie')?.includes('SESSDATA=fixture_session');
      return response({code:logged?0:-101,data:{isLogin:!!logged,mid:logged?uid:0,uname:'Fixture用户',face:'https://i0.hdslb.com/face.png',wbi_img:{img_url:'https://i0.hdslb.com/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://i0.hdslb.com/4932caff0ff746eab6f01bf08b70ac45.png'}}});
    }
    app.whenReady().then(async()=>{
      const network=session.fromPartition('persist:bili-service-fixture',{cache:false});
      const handleFixture=async request=>{
        const url=new URL(request.url), path=url.pathname;
        requests.push({host:url.hostname,path,range:request.headers.get('range'),referer:request.headers.get('referer'),cookie:!!request.headers.get('cookie'),signed:url.searchParams.has('w_rid')});
        if(url.hostname==='passport.bilibili.com') {
          if(path.endsWith('/generate')){
            const qrKey='fixture-key-'+ ++key;
            // The current official response encodes an account.bilibili.com
            // scan page. Only passport remains the network polling endpoint.
            const addresses={
              current:'https://account.bilibili.com/h5/account-h5/auth/scan-web',
              legacy:'https://passport.bilibili.com/h5-app/passport/login/scan',
              http:'http://account.bilibili.com/h5/account-h5/auth/scan-web',
              lookalike:'https://account.bilibili.com.evil.invalid/h5/account-h5/auth/scan-web',
              credential:'https://user:password@account.bilibili.com/h5/account-h5/auth/scan-web',
              port:'https://account.bilibili.com:444/h5/account-h5/auth/scan-web',
              wrongPath:'https://account.bilibili.com/unrelated-page',
              fragment:'https://account.bilibili.com/h5/account-h5/auth/scan-web',
            };
            return response({code:0,data:{url:addresses[qrAddress]+'?qrcode_key='+qrKey+(qrAddress==='fragment'?'#fixture-fragment':''),qrcode_key:qrKey}});
          }
          if(path.endsWith('/poll')) {
            if(login==='expired')return response({code:0,data:{code:86038}});
            if(login==='scanned')return response({code:0,data:{code:86090}});
            if(login==='confirm'){
              const headers=new Headers({'Content-Type':'application/json'});
              headers.append('Set-Cookie','SESSDATA=fixture_session; Domain=.bilibili.com; Path=/; HttpOnly; Secure; Max-Age=3600');
              headers.append('Set-Cookie','DedeUserID=456; Domain=.bilibili.com; Path=/; Secure; Max-Age=3600');
              return new Response(JSON.stringify({code:0,data:{code:0}}),{headers});
            }
            return response({code:0,data:{code:86101}});
          }
        }
        if(url.hostname==='api.bilibili.com') {
          if(path.endsWith('/nav')){
            const result=nav(request);
            if(navRemaining>0){navRemaining--;const fail=await new Promise(resolve=>{releaseNav=resolve;});if(fail)return response({},500);}
            return result;
          }
          if(path.endsWith('/view')){
            if(mode==='204')return response(null,204);
            if(mode==='restricted')return response({code:-403,message:'private remote token must not escape'});
            return response({code:0,data:{bvid,title:'Fixture <video>',owner:{name:'Fixture UP'},pic:'https://i0.hdslb.com/cover.png',duration:60,pages:[{cid:101,page:1,part:'第一P',duration:60},{cid:102,page:2,part:'第二P',duration:20}]}});
          }
          if(path.endsWith('/playurl')) {
            if(mode==='restricted')return response({code:-403});
            const deadline=Math.floor(clock/1000)+10000;
            return response({code:0,data:{quality:16,dash:{video:[{id:16,codecid:7,codecs:'avc1.64001f',baseUrl:'https://peer.mcdn.bilivideo.cn/video?deadline='+deadline,backupUrl:['https://upos-fixture.bilivideo.com/video?deadline='+deadline]},{id:80,codecid:12,codecs:'hev1',baseUrl:'https://upos-fixture.bilivideo.com/hevc?deadline='+deadline}],audio:[{id:30280,codecs:'mp4a.40.2',bandwidth:192000,baseUrl:'https://upos-fixture.bilivideo.com/audio?deadline='+deadline}]}}});
          }
          if(path.endsWith('/list.so'))return new Response('<i><d p="1.2,1,25,16777215,0,0,0,0">hello &lt;b&gt;</d></i>',{headers:{'Content-Type':'text/xml'}});
        }
        if(['upos-fixture.bilivideo.com','peer.mcdn.bilivideo.cn'].includes(url.hostname)) {
          if(mode==='redirect')return new Response('',{status:302,headers:{Location:'https://127.0.0.1/private'}});
          if(mode==='html')return new Response('<html>blocked</html>',{headers:{'Content-Type':'text/html'}});
          if(mode==='fallback'&&url.hostname.startsWith('upos-'))return new Response('',{status:503});
          const payload=Buffer.from('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ--');
          const range=request.headers.get('range');
          const match=/^bytes=(\\d+)-(\\d*)$/.exec(range??'');
          const start=match?Number(match[1]):0, end=match&&match[2]?Math.min(Number(match[2]),payload.length-1):payload.length-1;
          const headers={'Content-Type':mode==='webm'?'video/webm':'application/octet-stream','Accept-Ranges':'bytes','Content-Length':String(end-start+1)};
          if(match)headers['Content-Range']='bytes '+start+'-'+end+'/'+payload.length;
          return new Response(request.method==='HEAD'?null:payload.subarray(start,end+1),{status:match?206:200,headers});
        }
        if(url.hostname==='i0.hdslb.com')return new Response(Buffer.from([137,80,78,71]),{headers:{'Content-Type':'image/png'}});
        return new Response('',{status:403});
      };
      // Exercise actual native TLS and Set-Cookie headers. The fixture accepts
      // only its own generated certificate and changes only this Session.
      const origin=httpsServer({key:readFileSync(${JSON.stringify(keyPath)}),cert:readFileSync(${JSON.stringify(certificatePath)})},async(incoming,outgoing)=>{
        try {
          const fixtureRequest=new Request('https://'+incoming.headers.host+incoming.url,{method:incoming.method,headers:incoming.headers});
          const result=await handleFixture(fixtureRequest);
          const headers=Object.fromEntries(result.headers);
          const cookies=result.headers.getSetCookie();
          if(cookies.length)headers['set-cookie']=cookies;
          outgoing.writeHead(result.status,headers);
          outgoing.end(incoming.method==='HEAD'?undefined:Buffer.from(await result.arrayBuffer()));
        } catch {outgoing.writeHead(500);outgoing.end();}
      });
      await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));
      const proxy=proxyServer();
      proxy.on('connect',(request,client,head)=>{
        const hostname=request.url.split(':')[0];
        if(!${JSON.stringify(hosts)}.includes(hostname)){client.end('HTTP/1.1 403 Forbidden\\r\\n\\r\\n');return;}
        const upstream=connect(origin.address().port,'127.0.0.1',()=>{
          client.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
          if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);
        });
        upstream.on('error',()=>client.destroy());client.on('error',()=>upstream.destroy());client.on('close',()=>upstream.destroy());
      });
      await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
      network.setCertificateVerifyProc((request,callback)=>{
        const pin=new X509Certificate(request.certificate.data).fingerprint256;
        callback(${JSON.stringify(hosts)}.includes(request.hostname)&&pin===${JSON.stringify(fingerprint)}?0:request.errorCode);
      });
      const setProxy=network.setProxy.bind(network);
      network.setProxy=async config=>{globalThis.proxySystem=config.mode==='system';await setProxy({mode:'fixed_servers',proxyRules:'http=127.0.0.1:'+proxy.address().port+';https=127.0.0.1:'+proxy.address().port,proxyBypassRules:'<-loopback>'});};
      const create=()=>createBilibiliService({networkSession:network,now:()=>clock,qrPollIntervalMs:100,requestTimeoutMs:1500,onAuth:()=>{}});
      let service=await create();service.registerMediaProtocol(session.defaultSession);
      const recreate=async(failStore=false)=>{
        await service.flush();service.dispose();
        const readCookies=network.cookies.get;
        if(failStore)network.cookies.get=async()=>{throw new Error('fixture cookie store failure');};
        try{service=await create();}finally{network.cookies.get=readCookies;}
        service.registerMediaProtocol(session.defaultSession);
      };
      globalThis.biliServiceFixture={get service(){return service;},network,requests,setMode:value=>{mode=value;if(value==='delay-nav')navRemaining=1;},setLogin:value=>{login=value;},setQrAddress:value=>{qrAddress=value;},advance:value=>{clock+=value;},get navPending(){return !!releaseNav;},releaseNav(fail=false){const resolve=releaseNav;releaseNav=null;resolve?.(fail);},recreate};
      const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});await win.loadURL('about:blank');
    }).catch(error=>{console.error(error.message);app.exit(1);});
  `, resolveDir: resolve("."), sourcefile: "bili-service-fixture.ts", loader: "ts" },
  bundle: true, platform: "node", format: "cjs", target: "node22", outfile: harness, external: ["electron"], logLevel: "silent",
});
const env = { ...process.env, TOUCHFISH_USER_DATA: join(directory, "data") };
delete env.ELECTRON_RUN_AS_NODE;
let desktop;
const call = (operation, arg) => desktop.evaluate(async (_electron, { operation, arg }) => {
  const fixture = globalThis.biliServiceFixture;
  if (operation === "mode") return fixture.setMode(arg);
  if (operation === "login") return fixture.setLogin(arg);
  if (operation === "qrAddress") return fixture.setQrAddress(arg);
  if (operation === "advance") return fixture.advance(arg);
  if (operation === "requests") return fixture.requests;
  if (operation === "recreate") return fixture.recreate(arg);
  if (operation === "proxy") return globalThis.proxySystem;
  if (operation === "navPending") return fixture.navPending;
  if (operation === "releaseNav") return fixture.releaseNav(arg);
  if (operation === "beginPlayback") { fixture.pendingPlayback = fixture.service.resolvePlayback(arg).then(value => ({ value }), error => ({ error: error.message })); return; }
  if (operation === "endPlayback") return fixture.pendingPlayback;
  return fixture.service[operation](arg);
}, { operation, arg });

try {
  desktop = await electron.launch({ executablePath: electronPath, args: [harness], env });
  await desktop.firstWindow();
  expect(await call("proxy")).toBe(true);
  expect((await call("getAuth")).status).toBe("logged-out");
  console.log("Checking current/legacy scan URLs and rejection of untrusted QR addresses...");
  for (const address of ["http", "lookalike", "credential", "port", "wrongPath", "fragment"]) {
    await call("qrAddress", address);
    const rejected = await call("createQr");
    expect(rejected.status).toBe("error");
    expect(rejected.qrDataUrl).toBe(null);
    expect(rejected.message).toMatch(/二维码地址/);
  }
  await call("qrAddress", "legacy");
  expect((await call("createQr")).status).toBe("qr");
  await call("cancelLogin");
  await call("qrAddress", "current");
  console.log("Checking QR state transitions, credential isolation and saved login restoration...");
  const qr = await call("createQr");
  expect(qr.status).toBe("qr");
  expect(qr.qrDataUrl).toMatch(/^data:image\/png;base64,/);
  expect(JSON.stringify(qr)).not.toMatch(/qrcode_key|SESSDATA|fixture-key/);
  await call("login", "scanned");
  await expect.poll(async () => (await call("getAuth")).status).toBe("scanned");
  await call("login", "confirm");
  await expect.poll(async () => (await call("getAuth")).status).toBe("authenticated");
  expect((await call("getAuth")).user.name).toBe("Fixture用户");
  await call("recreate");
  await expect.poll(async () => (await call("getAuth")).loggedIn).toBe(true);

  console.log("Checking stale account responses, QR fresh nav and cookie-store failure isolation...");
  await call("mode", "delay-nav");
  await call("recreate");
  await expect.poll(() => call("navPending")).toBe(true);
  await call("logout");
  await call("releaseNav");
  await new Promise(resolve => setTimeout(resolve, 100));
  expect((await call("getAuth")).loggedIn).toBe(false);
  await call("mode", "good");
  await call("login", "waiting");
  await call("createQr");
  await call("mode", "delay-nav");
  await call("beginPlayback", { bvid: "BV1xx411c7mD", mode: "video" });
  await expect.poll(() => call("navPending")).toBe(true);
  await call("login", "confirm");
  // A guest WBI nav is still pending: login must force a new authenticated nav.
  await expect.poll(async () => (await call("getAuth")).loggedIn).toBe(true);
  await call("releaseNav");
  expect((await call("endPlayback")).error).toBeUndefined();
  expect((await call("getAuth")).loggedIn).toBe(true);
  await call("mode", "delay-nav");
  await call("recreate");
  await expect.poll(() => call("navPending")).toBe(true);
  await call("login", "waiting");
  await call("createQr");
  await call("releaseNav", true);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect((await call("getAuth")).status).toBe("qr");
  await call("cancelLogin");
  await call("mode", "good");
  await call("recreate", true);
  expect((await call("getAuth")).status).toBe("error");
  await call("recreate");
  await expect.poll(async () => (await call("getAuth")).loggedIn).toBe(true);

  console.log("Checking WBI, supported codecs, opaque media, ranges and CDN fallback...");
  const playback = await call("resolvePlayback", { bvid: "BV1xx411c7mD", mode: "video", quality: 80 });
  expect(playback.quality).toBe(16);
  expect(playback.qualities).toEqual([{ id: 16, label: "360P" }]);
  expect(playback.videoUrl).toMatch(/^touchfish-media:\/\/stream\/[a-f0-9]{48}$/);
  expect(playback.audioUrl).toMatch(/^touchfish-media:\/\/stream\/[a-f0-9]{48}$/);
  expect(JSON.stringify(playback)).not.toMatch(/deadline=|SESSDATA|bilivideo\.com/);
  const fetchMedia = (url, range, method = "GET") => desktop.evaluate(async ({ net }, args) => {
    const response = await net.fetch(args.url, { method: args.method, headers: args.range ? { Range: args.range } : {} });
    return { status: response.status, type: response.headers.get("content-type"), contentRange: response.headers.get("content-range"), body: await response.text() };
  }, { url, range, method });
  const video = await fetchMedia(playback.videoUrl, "bytes=5-10");
  expect(video).toMatchObject({ status: 206, contentRange: "bytes 5-10/64", body: "56789a" });
  const sent = (await call("requests")).find(value => value.path === "/video");
  expect(sent.host).toBe("upos-fixture.bilivideo.com");
  expect(sent.cookie).toBe(false);
  expect(sent.referer).toBe("https://www.bilibili.com/");
  expect((await call("requests")).some(value => value.path.endsWith("/playurl") && value.signed)).toBe(true);
  await call("mode", "fallback");
  expect((await fetchMedia(playback.videoUrl, "bytes=0-3")).status).toBe(206);
  expect((await call("requests")).some(value => value.host === "peer.mcdn.bilivideo.cn")).toBe(true);
  await call("mode", "webm");
  expect((await fetchMedia(playback.videoUrl)).type).toBe("video/webm");
  await call("mode", "html");
  expect((await fetchMedia(playback.videoUrl)).status).toBe(502);
  await call("mode", "redirect");
  expect((await fetchMedia(playback.videoUrl)).status).toBe(502);
  expect((await call("requests")).some(value => value.host === "127.0.0.1")).toBe(false);
  await call("mode", "good");
  const audio = await call("resolvePlayback", { bvid: "BV1xx411c7mD", mode: "audio" });
  expect(audio.videoUrl).toBe(null);
  expect(audio.audioUrl).toMatch(/^touchfish-media:/);
  const danmaku = await call("getDanmaku", 101);
  expect(danmaku).toEqual([{ time: 1.2, mode: 1, color: 16777215, text: "hello <b>" }]);
  await call("advance", 7_200_001);
  expect((await fetchMedia(playback.videoUrl)).status).toBe(410);

  console.log("Checking invalid API responses, expiry, cancel and logout...");
  await call("mode", "204");
  await expect(call("getVideo", "BV1xx411c7mE")).rejects.toThrow();
  await call("mode", "restricted");
  await expect(call("getVideo", "BV1xx411c7mE")).rejects.toThrow(/权限/);
  await call("mode", "good");
  expect((await call("logout")).loggedIn).toBe(false);
  expect((await call("getAuth")).user).toBe(null);
  await call("recreate");
  expect((await call("getAuth")).loggedIn).toBe(false);
  await call("login", "waiting");
  await call("createQr");
  await call("cancelLogin");
  await call("login", "confirm");
  await new Promise(resolve => setTimeout(resolve, 250));
  expect((await call("getAuth")).loggedIn).toBe(false);
  await call("login", "expired");
  await call("createQr");
  await expect.poll(async () => (await call("getAuth")).status).toBe("expired");
  await call("flush");
  expect((await call("requests")).some(value => value.host === "account.bilibili.com")).toBe(false);
  console.log("PASS: current/legacy trusted QR URLs and unsafe address rejection, login states/cancellation/logout, persistent cookies, auth response races and store failure isolation, WBI, real codec selection, opaque media streams, Range/206/referrer, fallback, HTML and redirect rejection, expiration and safe errors.");
} catch (error) {
  const state = await call("getAuth").catch(() => null);
  console.log(JSON.stringify({ status: state?.status, message: state?.message }));
  throw error;
} finally {
  await desktop?.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await desktop?.close().catch(() => {});
}

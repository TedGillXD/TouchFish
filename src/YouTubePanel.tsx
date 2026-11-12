import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ExternalLink, FolderOpen, Link2, LoaderCircle, LogIn, MonitorPlay, Pause, Play, Square } from "lucide-react";
import type { YouTubeBridge, YouTubeBrowser, YouTubePlayerState } from "./youtube-types";
import type { BiliTransportState } from "./bilibili-types";
import "./youtube.css";

const empty: YouTubePlayerState = { connected: false, browser: null, open: false, visible: false, minimized: false, loading: false, concealed: false,
  title: "", videoId: null, url: null, message: "请先加载配套扩展并连接浏览器。", currentTime: 0, duration: 0, volume: 1, playbackRate: 1 };
const time = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds)) % 60).padStart(2, "0")}`;
function errorText(error: unknown) {
  const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "") : "";
  return message && message.length < 150 && !/https?:|token|cookie|authorization|password/i.test(message) ? message : "操作未完成，请检查浏览器扩展连接后重试。";
}

export default function YouTubePanel({ onBack }: { onBack: () => void }) {
  const api = (window.touchFish as typeof window.touchFish & { youtube?: YouTubeBridge })?.youtube;
  const [state, setState] = useState(empty);
  const [transport, setTransport] = useState<BiliTransportState | null>(null);
  const [input, setInput] = useState("");
  const [browser, setBrowser] = useState<YouTubeBrowser>("default");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    if (!api) return () => { alive.current = false; };
    let active = true;
    let stateRevision = 0, transportRevision = 0;
    const offState = api.onState(next => { stateRevision++; if (active) setState(next); });
    const offTransport = api.onTransportState(next => { transportRevision++; if (active) setTransport(next); });
    void api.getState().then(next => { if (active && !stateRevision) setState(next); }).catch(() => {});
    void api.getTransportState().then(next => { if (active && !transportRevision) setTransport(next); }).catch(() => {});
    return () => { active = false; alive.current = false; offState(); offTransport(); };
  }, [api]);
  async function run(action: () => unknown | Promise<unknown>) {
    if (busy || !api) return;
    setBusy(true); setError("");
    try { await action(); }
    catch (cause) { if (alive.current) setError(errorText(cause)); }
    finally { if (alive.current) setBusy(false); }
  }
  return <div className="youtube-panel">
    <div className="youtube-heading"><button className="icon-button" aria-label="返回" onClick={onBack}><ArrowLeft size={19} /></button><div><h1>摸鱼 · YouTube</h1><p>使用已登录的 Chrome / Edge</p></div><span><MonitorPlay size={19} /></span></div>
    <section className="youtube-connection" aria-label="YouTube浏览器连接">
      <div className="youtube-section-heading"><strong><Link2 size={15} />浏览器连接</strong><span className={state.connected ? "connected" : ""}>{state.connected ? "已连接" : "未连接"}</span></div>
      <p>视频和 Google 登录均在真实浏览器完成，沿用浏览器中的账号。配套扩展只控制本应用创建的 YouTube 专属窗口。</p>
      <ol><li>打开 Chrome / Edge 的扩展管理页，开启开发者模式。</li><li>点击下方“打开扩展目录”，在浏览器选择“加载已解压的扩展程序”并选择该目录。</li><li>选择对应浏览器并连接，在本机配对页点击“连接此浏览器”。</li></ol>
      <button className="youtube-folder" onClick={() => void run(() => api!.openExtensionFolder())} disabled={!api || busy}><FolderOpen size={14} />打开扩展目录</button>
      <div className="youtube-connect-row"><select aria-label="YouTube浏览器" value={browser} onChange={event => setBrowser(event.target.value as YouTubeBrowser)}><option value="default">默认浏览器</option><option value="chrome">Google Chrome</option><option value="edge">Microsoft Edge</option></select><button onClick={() => void run(() => api!.connectBrowser(browser))} disabled={!api || busy}>{busy ? <LoaderCircle size={14} className="youtube-spin" /> : <Link2 size={14} />}连接浏览器</button></div>
      <small role="status">{state.message}</small>
    </section>
    <section className="youtube-open-section"><h2><Play size={14} />打开视频</h2><form onSubmit={event => { event.preventDefault(); void run(() => api!.open(input)); }}><input aria-label="YouTube链接或视频ID" value={input} maxLength={2048} autoComplete="off" placeholder="YouTube 链接或 11 位视频 ID" onChange={event => setInput(event.target.value)} /><button type="submit" disabled={!api || !state.connected || state.concealed || !input.trim() || busy}><Play size={14} />播放</button></form><button className="youtube-login" disabled={!api || !state.connected || state.concealed || busy} onClick={() => void run(() => api!.openLogin())}><LogIn size={13} />在专属窗口打开 YouTube / 登录</button></section>
    {state.open && <section className="youtube-current" aria-label="YouTube专属窗口"><strong>{state.title || "YouTube"}</strong><small>{state.duration > 0 ? `${time(state.currentTime)} / ${time(state.duration)}` : state.loading ? "等待网页播放器就绪" : "网页播放器"}{state.concealed ? " · 已被老板键收起" : state.minimized ? " · 已最小化" : ""}</small><div><button disabled={!api || busy || !transport?.ready || state.concealed} onClick={() => void run(() => api!.setPlaying(!transport!.playIntent, transport!.revision))} aria-label={transport?.playIntent ? "暂停YouTube播放" : "继续YouTube播放"}>{transport?.playIntent ? <Pause size={14} /> : <Play size={14} />}{transport?.playIntent ? "暂停" : "继续"}</button><button disabled={!api || state.concealed} onClick={() => api!.show()}><ExternalLink size={13} />打开窗口</button><button disabled={!api} onClick={() => api!.close()}><Square size={12} />关闭</button></div><div className="youtube-volume"><label>音量<input aria-label="YouTube音量" type="range" min="0" max="1" step="0.05" value={state.volume} disabled={!api || !transport?.ready || busy || state.concealed} onChange={event => void run(() => api!.setVolume(Number(event.target.value)))} /></label><select aria-label="YouTube倍速" value={state.playbackRate} disabled={!api || !transport?.ready || busy || state.concealed} onChange={event => void run(() => api!.setPlaybackRate(Number(event.target.value)))}>{[...new Set([.25,.5,.75,1,1.25,1.5,1.75,2,state.playbackRate])].sort((a,b)=>a-b).map(rate=><option key={rate} value={rate}>{rate}×</option>)}</select></div></section>}
    {error && <p className="youtube-error" role="alert">{error}</p>}
    <p className="youtube-note">扩展不读取 Cookie、密码或账号资料，也不会接管已有工作标签页。请在专属浏览器窗口中处理登录、验证码或内容限制；应用不代替浏览器完成认证。</p>
  </div>;
}

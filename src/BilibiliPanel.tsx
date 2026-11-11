import { useEffect, useRef, useState } from "react";
import { ArrowLeft, AudioLines, ExternalLink, LoaderCircle, LogOut, Play, QrCode, RefreshCw, Search, Square, TvMinimal } from "lucide-react";
import type { BiliAuthState, BiliMode, BiliPlayerState, BiliVideo } from "./bilibili-types";
import "./bilibili.css";

const initialAuth: BiliAuthState = {
  status: "loading", loggedIn: false, user: null, qrDataUrl: null,
  expiresAt: null, message: "正在读取登录状态…",
};
const initialPlayer: BiliPlayerState = { open: false, mode: "video", title: "", bvid: null };

function friendlyError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "") : "";
  return message && message.length < 180 && !/https?:\/\/|SESSDATA|qrcode_key|cookie\s*[:=]/i.test(message) ? message : fallback;
}
function duration(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return value >= 3600
    ? `${Math.floor(value / 3600)}:${String(Math.floor(value / 60) % 60).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`
    : `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

export default function BilibiliPanel({ onBack }: { onBack: () => void }) {
  const api = window.touchFish?.bilibili;
  const [auth, setAuth] = useState(initialAuth);
  const [player, setPlayer] = useState(initialPlayer);
  const [input, setInput] = useState("");
  const [video, setVideo] = useState<BiliVideo | null>(null);
  const [cid, setCid] = useState<number | undefined>();
  const [looking, setLooking] = useState(false);
  const [opening, setOpening] = useState<BiliMode | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(false);
  const lookupRevision = useRef(0);

  useEffect(() => {
    mounted.current = true;
    if (!api) {
      setAuth({ ...initialAuth, status: "error", message: "请在桌面应用中使用 B 站摸鱼。" });
      return () => { mounted.current = false; };
    }
    let active = true;
    let authRevision = 0;
    let playerRevision = 0;
    const offAuth = api.onAuth((next) => { authRevision++; if (active) setAuth(next); });
    const offPlayer = api.onPlayerState((next) => { playerRevision++; if (active) setPlayer(next); });
    void api.getAuth().then((next) => {
      if (active && authRevision === 0) setAuth(next);
    }).catch((cause) => {
      if (active) setAuth({ ...initialAuth, status: "error", message: friendlyError(cause, "登录状态读取失败，请重试。") });
    });
    void api.getPlayerState().then((next) => {
      if (active && playerRevision === 0) setPlayer(next);
    }).catch(() => {});
    return () => {
      active = false;
      mounted.current = false;
      lookupRevision.current++;
      offAuth();
      offPlayer();
      void api.cancelLogin().catch(() => {});
    };
  }, [api]);

  useEffect(() => {
    if (!auth.qrDataUrl || auth.loggedIn) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [auth.qrDataUrl, auth.loggedIn]);

  const authenticate = async () => {
    if (!api || authBusy) return;
    setAuthBusy(true);
    setError("");
    try {
      await api.createQr();
      if (mounted.current) setNow(Date.now());
    } catch (cause) {
      if (mounted.current) setError(friendlyError(cause, "二维码获取失败，请检查网络或系统代理后重试。"));
    } finally {
      if (mounted.current) setAuthBusy(false);
    }
  };
  const logout = async () => {
    if (!api || authBusy) return;
    setAuthBusy(true);
    try { await api.logout(); }
    catch (cause) { if (mounted.current) setError(friendlyError(cause, "退出登录失败，请重试。")); }
    finally { if (mounted.current) setAuthBusy(false); }
  };
  const lookup = async () => {
    if (!api || !input.trim()) return;
    const request = ++lookupRevision.current;
    setLooking(true);
    setVideo(null);
    setError("");
    setNotice("");
    try {
      const result = await api.getVideo(input.trim());
      if (mounted.current && request === lookupRevision.current) {
        setVideo(result);
        setCid(result.pages[0]?.cid);
      }
    } catch (cause) {
      if (mounted.current && request === lookupRevision.current) setError(friendlyError(cause, "无法读取视频，请核对 BV 号后重试。"));
    } finally {
      if (mounted.current && request === lookupRevision.current) setLooking(false);
    }
  };
  const play = async (mode: BiliMode) => {
    if (!api || !video || opening) return;
    setOpening(mode);
    setError("");
    setNotice("");
    try {
      await api.play({ bvid: video.bvid, cid, mode });
      if (mounted.current) setNotice(mode === "audio" ? "音频小窗已打开，收起主面板也能继续听。" : "视频小窗已打开，拖动窗口边缘可调整大小。");
    } catch (cause) {
      if (mounted.current) setError(friendlyError(cause, "播放地址获取失败，请稍后重试。"));
    } finally {
      if (mounted.current) setOpening(null);
    }
  };
  const expired = auth.status === "expired" || !!auth.expiresAt && now >= auth.expiresAt;
  const remaining = auth.expiresAt ? Math.max(0, Math.ceil((auth.expiresAt - now) / 1000)) : null;

  return (
    <div className="bili-panel">
      <div className="bili-panel-heading">
        <button className="icon-button" aria-label="返回" onClick={onBack}><ArrowLeft size={19} /></button>
        <div><h1>摸鱼 · B 站</h1><p>听点什么，也看点什么</p></div>
        <span className="bili-service-mark"><TvMinimal size={15} /></span>
      </div>

      <section className="bili-account-card" aria-label="B站登录">
        {auth.loggedIn ? (
          <div className="bili-account-row">
            {auth.user?.avatar ? <img className="bili-avatar" src={auth.user.avatar} alt="" /> : <span className="bili-avatar fallback"><TvMinimal size={20} /></span>}
            <div className="bili-account-name"><strong>{auth.user?.name || "已登录 B 站"}</strong><small>已登录 · 按账号可用画质播放</small></div>
            <button className="text-button" onClick={() => void logout()} disabled={authBusy}><LogOut size={13} />退出登录</button>
          </div>
        ) : (
          <>
            <div className="bili-login-heading"><span><QrCode size={16} />扫码登录</span><button className="text-button" disabled={!api || authBusy} onClick={() => void authenticate()}>
              {authBusy ? <LoaderCircle className="bili-spinning" size={13} /> : auth.qrDataUrl ? <RefreshCw size={13} /> : <QrCode size={13} />}
              {authBusy ? "正在获取" : auth.qrDataUrl ? "刷新二维码" : "获取二维码"}
            </button></div>
            {auth.qrDataUrl ? (
              <div className="bili-qr-row">
                <div className={`bili-qr ${expired ? "expired" : ""}`}>
                  <img src={auth.qrDataUrl} alt="B站扫码登录二维码" />
                  {expired && <span>二维码已过期</span>}
                  {auth.status === "scanned" && !expired && <span>已扫码，请在手机确认</span>}
                </div>
                <div className="bili-qr-copy"><strong>用 B 站 App 扫一扫</strong><p>{expired ? "点击刷新，重新获取登录码。" : "扫描左侧二维码，并在手机上确认登录。"}</p>{remaining !== null && !expired && <small>{remaining} 秒内有效</small>}</div>
              </div>
            ) : <p className="bili-login-note">登录后可使用账号支持的画质；也可以先播放公开可用的视频。</p>}
            <p className={`bili-auth-message ${auth.status === "error" ? "failed" : ""}`} role="status">{auth.message}</p>
          </>
        )}
      </section>

      <section className="bili-video-section">
        <h2><Search size={15} />输入 BV 号</h2>
        <form className="bili-search" onSubmit={(event) => { event.preventDefault(); void lookup(); }}>
          <input aria-label="BV号或视频链接" value={input} maxLength={512} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="BV 号或 B 站视频链接" onChange={(event) => {
            lookupRevision.current++;
            setInput(event.target.value);
            setVideo(null);
            setLooking(false);
            setError("");
            setNotice("");
          }} />
          <button aria-label="查找视频" type="submit" disabled={!api || !input.trim() || looking}>{looking ? <LoaderCircle size={17} className="bili-spinning" /> : <Search size={17} />}</button>
        </form>
        {video && (
          <div className="bili-video-card">
            {video.cover && <img className="bili-video-cover" src={video.cover} alt="" />}
            <div className="bili-video-info"><strong>{video.title}</strong><span>{video.owner} <i>·</i> {duration(video.duration)}</span><small>{video.bvid}</small></div>
            {video.pages.length > 1 && <label className="bili-page-field">选择分 P<select aria-label="视频分P" value={cid} onChange={(event) => setCid(Number(event.target.value))}>{video.pages.map((page) => <option key={page.cid} value={page.cid}>P{page.page} · {page.title}</option>)}</select></label>}
            <div className="bili-play-actions">
              <button className="secondary" onClick={() => void play("audio")} disabled={!!opening}><AudioLines size={16} />{opening === "audio" ? "正在打开…" : "听视频"}</button>
              <button className="primary" onClick={() => void play("video")} disabled={!!opening}><Play size={15} />{opening === "video" ? "正在打开…" : "看视频"}</button>
            </div>
          </div>
        )}
      </section>
      {error && <div className="bili-panel-error" role="alert">{error}</div>}
      {notice && <p className="bili-panel-notice" role="status">{notice}</p>}
      {player.open && <section className="bili-now-playing" aria-label="已打开的播放器"><span><AudioLines size={14} /><strong>{player.title}</strong></span><div><button className="text-button" onClick={() => api?.showPlayer()}><ExternalLink size={12} />打开小窗</button><button className="text-button" onClick={() => api?.closePlayer()}><Square size={11} />停止播放</button></div></section>}
      <p className="bili-panel-note">音频在小窗中持续播放。视频窗不置顶，鼠标移入显示控制，边缘可自由缩放。</p>
    </div>
  );
}

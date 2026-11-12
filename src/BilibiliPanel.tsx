import { useEffect, useRef, useState } from "react";
import { ArrowLeft, AudioLines, ChevronDown, ChevronUp, ExternalLink, History, LoaderCircle, LogOut, Play, QrCode, RefreshCw, Search, Square, Trash2, TvMinimal } from "lucide-react";
import type { BiliAuthState, BiliMode, BiliPlayerState, BiliVideo } from "./bilibili-types";
import type { BiliHistoryEntry, BiliHistoryState } from "./bilibili-history-types";
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
function historyTime(timestamp: number, now: number): string {
  const date = new Date(timestamp);
  if (timestamp <= 0 || !Number.isFinite(date.getTime())) return "时间未知";
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const sameDay = (other: Date) => date.getFullYear() === other.getFullYear() && date.getMonth() === other.getMonth() && date.getDate() === other.getDate();
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (sameDay(today)) return `今天 ${time}`;
  if (sameDay(yesterday)) return `昨天 ${time}`;
  return date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
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
  const [history, setHistory] = useState<BiliHistoryState>({ entries: [], error: null });
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  const [historyBusy, setHistoryBusy] = useState<string | null>(null);
  const [historyReload, setHistoryReload] = useState(0);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [clearHistoryConfirm, setClearHistoryConfirm] = useState(false);
  const [now, setNow] = useState(Date.now());
  const mounted = useRef(false);
  const lookupRevision = useRef(0);
  const historyRevision = useRef(0);

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
    if (!api) { setHistoryLoading(false); return; }
    let active = true;
    const accept = (next: BiliHistoryState) => {
      if (!active) return;
      setHistory(next);
      setHistoryLoading(false);
      setHistoryError("");
      if (!next.entries.length) setClearHistoryConfirm(false);
    };
    const offHistory = api.onHistory(next => { historyRevision.current++; accept(next); });
    const revision = historyRevision.current;
    setHistoryLoading(true);
    setHistoryError("");
    void api.getHistory().then(next => {
      if (revision === historyRevision.current) accept(next);
    }).catch(cause => {
      if (active && revision === historyRevision.current) {
        setHistoryLoading(false);
        setHistoryError(friendlyError(cause, "历史记录读取失败，请重试。"));
      }
    });
    return () => { active = false; offHistory(); };
  }, [api, historyReload]);

  useEffect(() => {
    const qrActive = !!auth.qrDataUrl && !auth.loggedIn;
    if (!qrActive && !history.entries.length) return;
    const timer = setInterval(() => setNow(Date.now()), qrActive ? 1000 : 30_000);
    return () => clearInterval(timer);
  }, [auth.qrDataUrl, auth.loggedIn, history.entries.length]);

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
  const lookup = async (value = input, preferredCid?: number | null) => {
    if (!api || !value.trim()) return;
    const request = ++lookupRevision.current;
    setLooking(true);
    setVideo(null);
    setError("");
    setNotice("");
    try {
      const result = await api.getVideo(value.trim());
      if (mounted.current && request === lookupRevision.current) {
        setVideo(result);
        setCid(result.pages.some(page => page.cid === preferredCid) ? preferredCid! : result.pages[0]?.cid);
        setNow(Date.now());
      }
    } catch (cause) {
      if (mounted.current && request === lookupRevision.current) setError(friendlyError(cause, "无法读取视频，请核对 BV 号后重试。"));
    } finally {
      if (mounted.current && request === lookupRevision.current) setLooking(false);
    }
  };
  const reopenHistory = (entry: BiliHistoryEntry) => {
    setInput(entry.bvid);
    void lookup(entry.bvid, entry.lastCid);
  };
  const manageHistory = async (bvid?: string) => {
    if (!api || historyBusy) return;
    const revision = historyRevision.current;
    setHistoryBusy(bvid ?? "clear");
    setHistoryError("");
    try {
      const next = bvid ? await api.removeHistory(bvid) : await api.clearHistory();
      if (mounted.current && historyRevision.current === revision) setHistory(next);
      if (mounted.current && !bvid) setClearHistoryConfirm(false);
    } catch (cause) {
      if (mounted.current) setHistoryError(friendlyError(cause, bvid ? "记录删除失败，请重试。" : "历史记录清空失败，请重试。"));
    } finally {
      if (mounted.current) setHistoryBusy(null);
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
      <section className="bili-history" aria-label="B站历史记录" aria-busy={!!historyBusy || historyLoading}>
        <div className="bili-history-heading"><h2><History size={14} />历史记录{history.entries.length > 0 && <small>{history.entries.length}</small>}</h2><button className="text-button" disabled={!api || historyLoading || !!historyBusy || (!history.entries.length && !history.error)} onClick={() => setClearHistoryConfirm(true)}><Trash2 size={12} />清空记录</button></div>
        <p className="bili-history-note">搜索和播放过的 BV 号保存在本机，点击记录可再次查找。</p>
        {clearHistoryConfirm && <div className="bili-history-confirm" role="group" aria-label="清空历史记录确认"><span>确认清空全部记录？</span><p>清空后无法恢复，正在播放的视频不受影响。</p><div><button className="text-button" disabled={!!historyBusy} onClick={() => setClearHistoryConfirm(false)}>取消清空</button><button className="bili-history-confirm-delete" disabled={!!historyBusy} onClick={() => void manageHistory()}>{historyBusy === "clear" ? <LoaderCircle className="bili-spinning" size={12} /> : <Trash2 size={12} />}确认清空</button></div></div>}
        {(historyError || history.error) && <div className="bili-history-error" role="alert"><span>{historyError || history.error}</span><button className="text-button" disabled={historyLoading || !!historyBusy} onClick={() => setHistoryReload(value => value + 1)}>重新读取</button></div>}
        {historyLoading ? <p className="bili-history-empty" role="status"><LoaderCircle size={13} className="bili-spinning" />正在读取记录…</p> : history.entries.length ? <>
          <ul className={`bili-history-list ${historyExpanded ? "expanded" : ""}`}>
            {(historyExpanded ? history.entries : history.entries.slice(0, 6)).map(entry => {
              const timestamp = Math.max(entry.lastSearchedAt ?? 0, entry.lastPlayedAt ?? 0);
              const date = new Date(timestamp);
              const hasDate = timestamp > 0 && Number.isFinite(date.getTime());
              const playedRecently = entry.lastPlayedAt !== null && entry.lastPlayedAt >= (entry.lastSearchedAt ?? 0);
              return <li className="bili-history-item" data-bvid={entry.bvid} key={entry.bvid}>
                <button className="bili-history-open" aria-label={`重新查找 ${entry.bvid}`} title={entry.title || entry.bvid} disabled={!api || !!historyBusy} onClick={() => reopenHistory(entry)}><span className="bili-history-title">{entry.title || entry.bvid}</span><span className="bili-history-meta"><span>{entry.bvid}</span>{entry.owner && <span className="bili-history-owner">{entry.owner}</span>}</span><span className="bili-history-detail"><span className={`bili-history-kind ${entry.lastMode ? "played" : ""}`}>{entry.lastMode === "audio" ? <AudioLines size={10} /> : entry.lastMode === "video" ? <Play size={10} /> : <Search size={10} />}{entry.lastMode === "audio" ? "听过" : entry.lastMode === "video" ? "看过" : "已搜索"}</span><time dateTime={hasDate ? date.toISOString() : undefined} title={hasDate ? date.toLocaleString("zh-CN") : undefined}>{playedRecently ? "播放" : "搜索"} · {historyTime(timestamp, now)}</time></span></button>
                <button className="bili-history-delete" aria-label={`删除记录 ${entry.bvid}`} title="删除这条记录" disabled={!api || !!historyBusy} onClick={() => void manageHistory(entry.bvid)}>{historyBusy === entry.bvid ? <LoaderCircle size={13} className="bili-spinning" /> : <Trash2 size={13} />}</button>
              </li>;
            })}
          </ul>
          {history.entries.length > 6 && <button className="bili-history-expand text-button" onClick={() => setHistoryExpanded(value => !value)}>{historyExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}{historyExpanded ? "收起记录" : `查看全部 ${history.entries.length} 条`}</button>}
        </> : <div className="bili-history-empty"><History size={17} /><strong>还没有记录</strong><span>搜索视频后会自动保存，重启应用后仍可查看。</span></div>}
      </section>
      <p className="bili-panel-note">音频在小窗中持续播放。视频窗不置顶，鼠标移入显示控制，边缘可自由缩放。</p>
    </div>
  );
}

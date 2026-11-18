import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Link2, MonitorPlay, QrCode, X } from "lucide-react";
import type { HongguoState } from "./hongguo-types";
import "./hongguo.css";

const initialState: HongguoState = {
  open: false,
  visible: false,
  concealed: false,
  loading: false,
  error: null,
};

function errorText(cause: unknown) {
  const message = cause instanceof Error
    ? cause.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "")
    : "";
  return message.length > 0 && message.length < 145 && !/https?:\/\/|cookie|token|authorization/i.test(message)
    ? message
    : "操作未完成，请重试。";
}

export default function HongguoPanel({ onBack }: { onBack: () => void }) {
  const api = window.touchFish?.hongguo;
  const [state, setState] = useState(initialState);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const connection = useRef<{ revision: number } | null>(null);

  useEffect(() => {
    if (!api) return;
    const current = { revision: 0 };
    connection.current = current;
    const unsubscribe = api.onState(next => {
      if (connection.current !== current) return;
      current.revision++;
      setState(next);
    });
    void api.getState().then(next => {
      if (connection.current === current && current.revision === 0) setState(next);
    }).catch(() => {
      if (connection.current === current && current.revision === 0) {
        setError("小窗状态读取失败，请重新打开小窗。");
      }
    });
    return () => {
      connection.current = null;
      unsubscribe();
    };
  }, [api]);

  async function run(action: () => Promise<HongguoState | void>) {
    const current = connection.current;
    if (!current || busy) return;
    const revision = current.revision;
    setBusy(true);
    setError("");
    try {
      const next = await action();
      if (next && connection.current === current && revision === current.revision) setState(next);
    } catch (cause) {
      if (connection.current === current) setError(errorText(cause));
    } finally {
      if (connection.current === current) setBusy(false);
    }
  }

  const canOpen = !!api && !state.concealed && !state.loading && !busy;
  const status = !api ? "请在桌面应用中使用" : state.concealed ? "老板键已收起小窗"
    : state.loading ? "正在加载官网…" : !state.open ? "小窗未打开"
      : state.visible ? "小窗已打开" : "小窗已隐藏";
  const message = error || state.error;

  return (
    <div className="hongguo-panel">
      <div className="panel-title">
        <button className="icon-button" type="button" aria-label="返回" onClick={onBack}><ArrowLeft size={19} /></button>
        <div>
          <h1>摸鱼 · 红果短剧</h1>
          <p>在无边框小窗搜索、选集和播放</p>
        </div>
      </div>
      <section className="settings-group hongguo-window" aria-label="红果短剧小窗">
        <div className="hongguo-card-heading">
          <h2><QrCode size={16} />红果 App 扫码登录</h2>
          <span role="status" className={state.visible ? "hongguo-status-active" : undefined}>{status}</span>
        </div>
        <p>在小窗点击官网的「登录」，再用手机红果短剧 App 的「我的 → 右上角菜单 → 扫一扫」扫码。</p>
        <p>登录会话保存在本机，有效期内重开小窗可沿用。可播放的剧集以官网为准。</p>
        <div className="hongguo-actions">
          <button className="hongguo-primary" type="button" disabled={!canOpen} onClick={() => void run(() => api!.open())}>
            <MonitorPlay size={15} />{state.open ? "显示红果小窗" : "打开红果小窗"}
          </button>
          {state.open && <button className="secondary" type="button" disabled={!api || busy} onClick={() => void run(() => api!.close())}>
            <X size={14} />关闭红果小窗
          </button>}
        </div>
      </section>
      <section className="hongguo-link" aria-label="通过官网链接打开剧集">
        <h2><Link2 size={15} />剧集链接</h2>
        <form onSubmit={event => {
          event.preventDefault();
          if (canOpen && input.trim()) void run(() => api!.open(input.trim()));
        }}>
          <input aria-label="红果短剧链接" type="text" inputMode="url" autoComplete="off" spellCheck={false} maxLength={2048}
            placeholder="粘贴红果官网链接" value={input} onChange={event => { setInput(event.target.value); setError(""); }} />
          <button className="hongguo-primary" type="submit" disabled={!canOpen || !input.trim()}>打开剧集</button>
        </form>
      </section>
      <p className="hongguo-hint">点击播放器的全屏按钮，画面可填满小窗。拖动顶部移动，拖动边缘调整大小。</p>
      {state.concealed && <p className="hongguo-hint">从托盘菜单恢复摸鱼窗口后，手动继续播放。</p>}
      {message && <p className="hongguo-error" role="alert">{message}</p>}
    </div>
  );
}

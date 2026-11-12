import { useEffect, useRef, useState } from "react";
import { EyeOff, Keyboard, RotateCcw } from "lucide-react";
import { DEFAULT_BOSS_SHORTCUT, type BossKeyApi, type BossKeyState } from "./boss-key-types";
import "./boss-key.css";

const friendlyError = (cause: unknown) => {
  const message = cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "") : "";
  return message && message.length < 180 && !/https?:|password|cookie|token/i.test(message)
    ? message : "老板键设置失败，请重试。";
};
const shortcutLabel = (shortcut: string, mac: boolean) => shortcut.split("+").map(part => ({
  CommandOrControl: mac ? "⌘" : "Ctrl", Command: "⌘", Control: "Ctrl", Alt: mac ? "⌥" : "Alt",
  Shift: "Shift", Super: mac ? "⌘" : "Win", Space: "空格", Up: "↑", Down: "↓", Left: "←", Right: "→",
} as Record<string, string>)[part] ?? part).join(" + ");

/** Boss-key preferences apply immediately, independently of the wage draft. */
export default function BossKeySettings() {
  const api: BossKeyApi | undefined = window.touchFish?.bossKey;
  const mac = window.touchFish?.platform === "darwin";
  const [state, setState] = useState<BossKeyState | null>(null);
  const [draft, setDraft] = useState(DEFAULT_BOSS_SHORTCUT);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const mounted = useRef(false);
  const savedShortcut = useRef<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    if (!api) return () => { mounted.current = false; };
    let active = true;
    let revision = 0;
    const accept = (next: BossKeyState) => {
      if (!active || !mounted.current) return;
      if (savedShortcut.current !== next.shortcut) {
        savedShortcut.current = next.shortcut;
        setDraft(next.shortcut);
      }
      setState(next);
    };
    const off = api.onState(next => { revision++; accept(next); });
    void api.getState().then(next => { if (revision === 0) accept(next); })
      .catch(cause => { if (active && mounted.current) setError(friendlyError(cause)); });
    return () => { active = false; mounted.current = false; off(); };
  }, [api, reload]);

  const act = async (operation: () => Promise<BossKeyState>) => {
    if (saving || state?.busy) return;
    setSaving(true);
    setError("");
    try { await operation(); }
    catch (cause) { if (mounted.current) setError(friendlyError(cause)); }
    finally { if (mounted.current) setSaving(false); }
  };
  const busy = saving || state?.busy === true;
  const displayedError = error || state?.error;
  if (!api) return null;
  return <section className="settings-group boss-key-settings" aria-label="老板键设置">
    <h2><EyeOff size={15} />老板键</h2>
    <p className="boss-key-description">一键暂停摸鱼媒体并收起相关窗口，工资计时继续。恢复窗口后不会自动播放。</p>
    <label className="boss-key-field">
      <span>全局快捷键</span>
      <div className="boss-key-input-row">
        <span className="boss-key-capture"><Keyboard size={15} /><input
          aria-label="老板键快捷键"
          value={shortcutLabel(draft, mac)}
          readOnly
          disabled={!state || busy}
          placeholder="点击后按下组合键"
          onKeyDown={event => {
            if (event.key === "Tab") return;
            event.preventDefault();
            if (["Control", "Alt", "Meta", "Shift"].includes(event.key)) return;
            if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
              setDraft(state?.shortcut ?? DEFAULT_BOSS_SHORTCUT); setError(""); return;
            }
            const key = /^Key[A-Z]$/.test(event.code) ? event.code.slice(3)
              : /^Digit\d$/.test(event.code) ? event.code.slice(5)
                : /^F(?:[1-9]|1\d|2[0-4])$/.test(event.key) ? event.key
                  : ({ " ": "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Enter: "Enter", Backspace: "Backspace", Delete: "Delete", Insert: "Insert", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Escape: "Escape" } as Record<string, string>)[event.key];
            if (!key || !/^F\d+$/.test(key) && !event.ctrlKey && !event.altKey && !event.metaKey) {
              setError("请按 Ctrl、Command、Alt 等组合键，或 F1–F24 功能键。"); return;
            }
            const modifiers = [event.metaKey ? mac ? "Command" : "Super" : null, event.ctrlKey ? "Control" : null,
              event.altKey ? "Alt" : null, event.shiftKey ? "Shift" : null].filter(Boolean);
            setDraft([...modifiers, key].join("+"));
            setError("");
          }}
        /></span>
        <button className="secondary boss-key-save" disabled={!api || !state || busy}
          onClick={() => api && void act(() => api.setShortcut(draft))}>保存快捷键</button>
      </div>
    </label>
    <p className="boss-key-hint">点击输入框后按组合键，保存后立即生效。默认 {shortcutLabel(DEFAULT_BOSS_SHORTCUT, mac)}，再次按下仍只收起。</p>
    <div className="boss-key-actions">
      <button className="text-button" disabled={!api || !state || busy} onClick={() => api && void act(() => api.setShortcut(DEFAULT_BOSS_SHORTCUT))}><RotateCcw size={12} />恢复默认</button>
      <span className={`boss-key-status ${state?.registered ? "registered" : ""}`} role="status">{!state ? "正在读取" : state.registered ? "快捷键已注册" : "快捷键未注册"}</span>
      <button className="text-button" disabled={!state || busy} onClick={() => void act(() => state?.hidden ? api.restore() : api.trigger())}>{state?.hidden ? "恢复摸鱼窗口" : "立即收起"}</button>
    </div>
    {displayedError && <p className="boss-key-error" role="alert">{displayedError}{!state && <button className="text-button" onClick={() => { setError(""); setReload(value => value + 1); }}>重试读取</button>}</p>}
  </section>;
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_BOSS_SHORTCUT, type BossKeyState } from "../src/boss-key-types";

interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}
interface BossKeyStorage {
  read(): Promise<unknown>;
  write(shortcut: string): Promise<void>;
}
interface BossKeyOptions {
  directory: string;
  shortcuts: ShortcutRegistry;
  /** Hide/minimize synchronously before awaiting media acknowledgements. */
  onTrigger: () => Promise<void> | void;
  /** Re-hide synchronously during a pending trigger without repeating media commands. */
  onRepeatTrigger?: () => void;
  /** Restore windows only. This callback must never resume media playback. */
  onRestore: () => Promise<void> | void;
  onState: (state: BossKeyState) => void;
  /** Main-process-only fixture hooks; never supplied by a renderer. */
  storage?: BossKeyStorage;
  actionTimeoutMs?: number;
}

const modifierNames: Record<string, string> = {
  commandorcontrol: "CommandOrControl", cmdorctrl: "CommandOrControl",
  command: "Command", cmd: "Command", control: "Control", ctrl: "Control",
  alt: "Alt", option: "Alt", shift: "Shift", super: "Super", meta: "Super",
};
const modifierOrder = ["CommandOrControl", "Command", "Control", "Alt", "Shift", "Super"];
const namedKeys: Record<string, string> = {
  space: "Space", enter: "Enter", return: "Enter", escape: "Escape", esc: "Escape",
  backspace: "Backspace", delete: "Delete", insert: "Insert", home: "Home", end: "End",
  pageup: "PageUp", pagedown: "PageDown", up: "Up", down: "Down", left: "Left", right: "Right",
};

/** Accept a single, bounded keyboard shortcut, not an arbitrary Electron command. */
export function normalizeBossShortcut(value: unknown): string {
  const invalid = () => new Error("请使用功能键，或包含 Ctrl、Command、Alt 等修饰键的组合键。");
  if (typeof value !== "string" || value.length > 100 || /[\r\n\u0000]/.test(value)) throw invalid();
  const parts = value.trim().split("+").map(part => part.trim());
  if (!parts.length || parts.some(part => !part) || parts.length > 5) throw invalid();
  const last = parts.pop()!;
  const modifiers = parts.map(part => Object.hasOwn(modifierNames, part.toLowerCase()) ? modifierNames[part.toLowerCase()] : undefined);
  if (modifiers.some(part => !part) || new Set(modifiers).size !== modifiers.length) throw invalid();
  if (modifiers.includes("CommandOrControl") && modifiers.some(part => part === "Command" || part === "Control")) throw invalid();
  const key = /^[a-z0-9]$/i.test(last) ? last.toUpperCase()
    : /^f(?:[1-9]|1\d|2[0-4])$/i.test(last) ? last.toUpperCase()
      : Object.hasOwn(namedKeys, last.toLowerCase()) ? namedKeys[last.toLowerCase()] : undefined;
  if (!key) throw invalid();
  if (!/^F\d+$/.test(key) && !modifiers.some(part => part !== "Shift")) throw invalid();
  return [...modifierOrder.filter(part => modifiers.includes(part)), key].join("+");
}

function diskStorage(directory: string): BossKeyStorage {
  const path = join(directory, "boss-key.json");
  const temporary = join(directory, "boss-key.tmp.json");
  return {
    async read() {
      const raw = await readFile(path, "utf8");
      if (Buffer.byteLength(raw) > 16_384) throw new Error("Invalid preference size");
      return JSON.parse(raw);
    },
    async write(shortcut) {
      await mkdir(directory, { recursive: true });
      await writeFile(temporary, JSON.stringify({ version: 1, shortcut }, null, 2), { encoding: "utf8", mode: 0o600, flush: true });
      await rename(temporary, path);
    },
  };
}

/** Native shortcut ownership is injected so tests never register a host hotkey. */
export async function createBossKeyController(options: BossKeyOptions) {
  const storage = options.storage ?? diskStorage(options.directory);
  const timeout = Math.max(100, Math.min(options.actionTimeoutMs ?? 6000, 30_000));
  const owned = new Set<string>();
  const cancellations = new Set<() => void>();
  let disposed = false;
  let operations = 0;
  let actionRevision = 0;
  let triggerPending: Promise<BossKeyState> | null = null;
  let settingsQueue: Promise<void> = Promise.resolve();
  let state: BossKeyState = {
    shortcut: DEFAULT_BOSS_SHORTCUT, registered: false, hidden: false, busy: false, error: null,
  };
  const getState = (): BossKeyState => ({ ...state });
  const publish = () => {
    state = { ...state, busy: operations > 0 };
    if (!disposed) {
      try { options.onState(getState()); } catch { /* A closing panel can obtain a fresh snapshot on reopen. */ }
    }
  };
  const assertOpen = () => { if (disposed) throw new Error("老板键服务已关闭。"); };
  const unregister = (shortcut: string) => {
    if (!owned.has(shortcut)) return;
    try { options.shortcuts.unregister(shortcut); } catch { /* Shutdown must still release other owned keys. */ }
    owned.delete(shortcut);
  };
  const register = (shortcut: string): boolean => {
    try {
      if (!options.shortcuts.register(shortcut, () => { void trigger().catch(() => {}); })) return false;
      owned.add(shortcut);
      return true;
    } catch { return false; }
  };
  async function bounded(callback: () => Promise<void> | void, message: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    const canceled = new Promise<never>((_, reject) => {
      cancel = () => reject(new Error("老板键服务已关闭。"));
      cancellations.add(cancel);
    });
    try {
      await Promise.race([
        Promise.resolve(callback()),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeout); }),
        canceled,
      ]);
    } finally {
      clearTimeout(timer);
      if (cancel) cancellations.delete(cancel);
    }
  }

  function trigger(): Promise<BossKeyState> {
    if (disposed) return Promise.reject(new Error("老板键服务已关闭。"));
    actionRevision++;
    state = { ...state, hidden: true, error: null };
    // A second keypress stays concealed. It also invalidates a waiting restore.
    if (triggerPending) {
      try { options.onRepeatTrigger?.(); } catch { /* Keep the original pause operation and cancellation revision intact. */ }
      publish();
      return triggerPending;
    }
    operations++;
    publish();
    const operation = (async () => {
      try {
        await bounded(options.onTrigger, "摸鱼窗口正在收起，部分媒体未确认暂停；请重新按老板键。");
        return getState();
      } catch {
        state = { ...state, error: "摸鱼窗口已要求收起，部分媒体未确认暂停；请重新按老板键。" };
        throw new Error(state.error!);
      } finally {
        operations--;
        triggerPending = null;
        publish();
      }
    })().then(() => getState());
    triggerPending = operation;
    return operation;
  }

  async function restore(): Promise<BossKeyState> {
    assertOpen();
    const revision = ++actionRevision;
    operations++;
    state = { ...state, error: null };
    publish();
    try {
      await triggerPending?.catch(() => {});
      assertOpen();
      if (revision !== actionRevision) return getState();
      await bounded(options.onRestore, "恢复窗口超时，请从托盘重新打开。");
      if (revision === actionRevision) state = { ...state, hidden: false, error: null };
    } catch {
      if (revision === actionRevision) state = { ...state, error: "恢复窗口失败，请从托盘重新打开。" };
      throw new Error("恢复窗口失败，请从托盘重新打开。");
    } finally {
      operations--;
      publish();
    }
    return getState();
  }

  function setShortcut(value: unknown): Promise<BossKeyState> {
    const operation = settingsQueue.then(async () => {
      assertOpen();
      const shortcut = normalizeBossShortcut(value);
      const previous = state.shortcut;
      const alreadyOwned = state.registered && shortcut === previous;
      operations++;
      publish();
      try {
        // Reserve the replacement first. If unavailable, the old key stays live.
        if (!alreadyOwned && !register(shortcut)) {
          state = { ...state, error: "快捷键已被占用或当前系统不支持，请换一个组合；原快捷键保持不变。" };
          throw new Error(state.error!);
        }
        try { await storage.write(shortcut); }
        catch {
          if (!alreadyOwned) unregister(shortcut);
          state = { ...state, error: "快捷键未能保存，原快捷键保持不变，请重试。" };
          throw new Error(state.error!);
        }
        assertOpen();
        if (shortcut !== previous) unregister(previous);
        state = { ...state, shortcut, registered: true, error: null };
      } finally {
        operations--;
        publish();
      }
      return getState();
    });
    settingsQueue = operation.then(() => {}, () => {});
    return operation;
  }

  try {
    const raw = await storage.read();
    if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      (raw as Record<string, unknown>).version !== 1) throw new Error("Invalid preference");
    state.shortcut = normalizeBossShortcut((raw as Record<string, unknown>).shortcut);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      state.error = "老板键配置暂不可读，已使用默认快捷键；可在此重新设置。";
  }
  state.registered = register(state.shortcut);
  if (!state.registered)
    state.error = "老板键注册失败，快捷键可能被占用或当前系统不支持全局快捷键；可在此更换。";
  publish();

  return {
    getState, setShortcut, trigger, restore,
    async flush() { await settingsQueue; },
    dispose() {
      if (disposed) return;
      disposed = true;
      actionRevision++;
      state = { ...state, registered: false };
      for (const cancel of [...cancellations]) cancel();
      for (const shortcut of [...owned]) unregister(shortcut);
    },
  };
}

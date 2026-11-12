import type { BiliTransportCommand, BiliTransportReport, BiliTransportState } from "../src/bilibili-types";

interface TransportOptions {
  send: (command: BiliTransportCommand) => void;
  onState: (state: BiliTransportState) => void;
  timeoutMs?: number;
}
interface PendingCommand {
  id: number;
  revision: number;
  playing: boolean;
  resolve: (state: BiliTransportState) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
const empty = (revision = 0, open = false): BiliTransportState => ({
  revision, open, ready: false, playing: false, playIntent: false,
  buffering: false, ended: false, failed: false,
});
const fields = ["ready", "playing", "playIntent", "buffering", "ended", "failed"] as const;

/** Owns command lifetimes; only the trusted player reports actual media state. */
export function createBilibiliTransport(options: TransportOptions) {
  let state = empty();
  let nextCommand = 0;
  let pending: PendingCommand | null = null;
  const getState = (): BiliTransportState => ({ ...state });
  const publish = () => options.onState(getState());
  function cancel(message: string) {
    if (!pending) return;
    const command = pending;
    pending = null;
    clearTimeout(command.timer);
    command.reject(new Error(message));
  }
  function beginSource(): number {
    cancel("播放来源已切换，请重试。");
    state = empty(state.revision + 1, true);
    publish();
    return state.revision;
  }
  function close() {
    cancel("播放器已关闭。");
    state = empty(state.revision + 1);
    publish();
  }
  function report(value: unknown, commandId?: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value) || !state.open) return false;
    const raw = value as Record<string, unknown>;
    if (!Number.isSafeInteger(raw.revision) || raw.revision !== state.revision ||
      fields.some(field => typeof raw[field] !== "boolean") ||
      commandId !== undefined && (!Number.isSafeInteger(commandId) || Number(commandId) < 1)) return false;
    // A late acknowledgement for a replaced command cannot overwrite newer intent.
    if (commandId !== undefined && (!pending || pending.id !== commandId || pending.revision !== state.revision)) return false;
    const next = raw as unknown as BiliTransportReport;
    state = {
      open: true, revision: state.revision, ready: next.ready,
      playing: next.ready && next.playing && next.playIntent && !next.buffering && !next.ended && !next.failed,
      playIntent: next.playIntent && !next.ended && !next.failed,
      buffering: next.buffering && next.playIntent && !next.ended && !next.failed,
      ended: next.ended, failed: next.failed,
    };
    publish();
    if (pending && pending.id === commandId) {
      const command = pending;
      pending = null;
      clearTimeout(command.timer);
      if (state.playIntent !== command.playing)
        command.reject(new Error("播放操作未完成，请在播放器中重试。"));
      else command.resolve(getState());
    }
    return true;
  }
  function setPlaying(playing: unknown, expectedRevision: unknown): Promise<BiliTransportState> {
    if (typeof playing !== "boolean" || !Number.isSafeInteger(expectedRevision))
      return Promise.reject(new Error("播放控制参数无效。"));
    if (!state.open || !state.ready) return Promise.reject(new Error("播放器尚未就绪，请稍后重试。"));
    if (expectedRevision !== state.revision) return Promise.reject(new Error("播放来源已切换，请重试。"));
    if (playing && state.failed) return Promise.reject(new Error("请先在播放器中重试播放。"));
    cancel("播放操作已被后续请求替换。");
    return new Promise((resolve, reject) => {
      const id = ++nextCommand;
      const revision = state.revision;
      const timer = setTimeout(() => {
        if (pending?.id === id) cancel("播放器响应超时，请在小窗中重试。");
      }, options.timeoutMs ?? 5000);
      pending = { id, revision, playing, resolve, reject, timer };
      try { options.send({ id, revision, playing }); }
      catch { cancel("播放器暂时无法响应，请重试。"); }
    });
  }
  return { getState, beginSource, close, report, setPlaying };
}

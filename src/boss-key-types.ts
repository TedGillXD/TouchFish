export const DEFAULT_BOSS_SHORTCUT = "CommandOrControl+Alt+B";

/** Window concealment and shortcut preferences are independent of payroll. */
export interface BossKeyState {
  shortcut: string;
  registered: boolean;
  hidden: boolean;
  busy: boolean;
  error: string | null;
}

export interface BossKeyApi {
  getState(): Promise<BossKeyState>;
  setShortcut(shortcut: string): Promise<BossKeyState>;
  trigger(): Promise<BossKeyState>;
  restore(): Promise<BossKeyState>;
  onState(callback: (state: BossKeyState) => void): () => void;
}

export interface HongguoState {
  open: boolean;
  visible: boolean;
  concealed: boolean;
  loading: boolean;
  error: string | null;
}

export type HongguoWindowAction = "back" | "home" | "reload" | "minimize" | "close";

export interface HongguoApi {
  getState(): Promise<HongguoState>;
  open(input?: string): Promise<HongguoState>;
  close(): Promise<void>;
  onState(callback: (state: HongguoState) => void): () => void;
}

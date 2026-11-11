export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error"
  | "unsupported";
export type UpdateMode = "automatic" | "installer";

export interface UpdateState {
  currentVersion: string;
  latestVersion: string | null;
  status: UpdateStatus;
  mode: UpdateMode;
  systemProxy: true;
  message: string;
  progress: number;
  transferred: number;
  total: number;
  releaseUrl: string;
  installLabel: string;
}

export interface UpdateApi {
  getState(): Promise<UpdateState>;
  check(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  install(): Promise<void>;
  openReleasePage(): Promise<void>;
  onState(callback: (state: UpdateState) => void): () => void;
}

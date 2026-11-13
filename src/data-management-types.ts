export interface GitSyncConfig { repository: string; branch: string }
export interface GitSyncState {
  config: GitSyncConfig | null;
  gitAvailable: boolean | null;
  busy: boolean;
  remote: { commit: string | null; fileExists: boolean; bytes: number } | null;
  lastCheckedAt: number | null;
  lastSyncedAt: number | null;
  error: string | null;
}
export interface BackupPreview {
  id: string;
  source: "file" | "git" | "recovery";
  name: string;
  exportedAt: string | null;
  appVersion: string | null;
  recordCount: number;
  historyCount: number | null;
  includesPreferences: boolean;
}
export interface DataManagementState {
  busy: boolean;
  message: string | null;
  error: string | null;
  lastExportAt: number | null;
  lastRestoreAt: number | null;
  recoveryAvailable: boolean;
  git: GitSyncState;
}
export interface DataManagementApi {
  getState(): Promise<DataManagementState>;
  exportBackup(): Promise<{ canceled: boolean; fileName?: string }>;
  previewImport(): Promise<BackupPreview | null>;
  previewRemote(): Promise<BackupPreview>;
  previewRecovery(): Promise<BackupPreview>;
  restorePreview(id: string, includePreferences?: boolean): Promise<void>;
  cancelPreview(id: string): Promise<void>;
  configureGit(config: GitSyncConfig | null): Promise<DataManagementState>;
  checkGit(): Promise<DataManagementState>;
  uploadGit(): Promise<DataManagementState>;
  onState(callback: (state: DataManagementState) => void): () => void;
}

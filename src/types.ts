export type SessionStatus = 'starting' | 'active' | 'idle' | 'interrupted' | 'dead';
export type IndicatorMode = 'off' | 'typing';

export interface Session {
  id: string;
  name: string;
  discordChannelId: string;
  discordChannelName: string;
  tmuxSession: string;
  projectDir: string;
  pid: number | null;
  status: SessionStatus;
  createdAt: number;
  lastActiveAt: number;
  lastCheckpointAt: number | null;
  checkpointPath: string | null;
  resumeCount: number;
  interruptedAt: number | null;
  indicatorMode: IndicatorMode | null;
}

export interface Checkpoint {
  sessionId: string;
  sessionName: string;
  projectDir: string;
  writtenAt: number;
  gitBranch: string | null;
  gitLastCommit: string | null;
  taskSummary: string | null;
  recentMessages: CheckpointMessage[];
}

export interface CheckpointMessage {
  author: string;
  content: string;
  timestamp: number;
}

export interface SpawnRequest {
  name: string;
  projectDir?: string;
  requestedBy: string;
  resumeFromCheckpoint?: string;
}

export interface ResumeResult {
  session: Session;
  checkpointUsed: boolean;
  messagesInjected: number;
  resumePromptLength: number;
}

export interface DaemonResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface ReconciliationReport {
  liveAndHealthy: string[];
  reattached: string[];
  interrupted: string[];
  cleaned: string[];
}

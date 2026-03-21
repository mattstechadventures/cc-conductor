export type SessionStatus = 'starting' | 'active' | 'idle' | 'interrupted' | 'dead';
export type AgentBackend = 'claude' | 'codex';
export type BackendState = 'never_started' | 'active' | 'parked';
export type IndicatorMode = 'off' | 'typing';
export type TerminalBackend = 'pty' | 'tmux' | 'none';
export type TransportKind = 'channel' | 'pty_fallback' | 'tmux_polling' | 'worker_http';
export type TransportState = 'connected' | 'degraded' | 'disconnected';
export type WorkerStatus = 'starting' | 'ready' | 'stopped' | 'exited' | 'unknown';
export type WorkerLaunchMode = 'new' | 'resume' | 'resume-prompt';

export interface ClaudeVersion {
  major: number;
  minor: number;
  patch: number;
}

export interface Session {
  id: string;
  name: string;
  discordChannelId: string;
  discordChannelName: string;
  tmuxSession: string | null;
  projectDir: string;
  additionalDirs: string[];
  pid: number | null;
  status: SessionStatus;
  createdAt: number;
  lastActiveAt: number;
  lastCheckpointAt: number | null;
  checkpointPath: string | null;
  resumeCount: number;
  interruptedAt: number | null;
  indicatorMode: IndicatorMode | null;
  workerId: string | null;
  terminalBackend: TerminalBackend;
  terminalHandle: string | null;
  transportKind: TransportKind;
  transportState: TransportState;
  activeBackend: AgentBackend;
  backendStates: SessionBackendSummary[];
  claudeSessionName: string;
  claudeResumeRef: string | null;
  workerStatus: WorkerStatus;
}

export interface SessionBackend {
  sessionId: string;
  backend: AgentBackend;
  nativeSessionName: string | null;
  nativeResumeRef: string | null;
  state: BackendState;
  lastActiveAt: number | null;
  lastHandoffAt: number | null;
}

export interface SessionBackendSummary extends SessionBackend {
  resumable: boolean;
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
  agentBackend?: AgentBackend;
  resumeFromCheckpoint?: string;
}

export interface AddDirRequest {
  path: string;
}

export interface ResumeResult {
  session: Session;
  checkpointUsed: boolean;
  messagesInjected: number;
  resumePromptLength: number;
  resumeStrategy: 'cli' | 'checkpoint' | 'worker';
}

export interface AddDirResult {
  session: Session;
  addedDir: string;
  resumeStrategy: 'cli' | 'checkpoint' | 'worker';
}

export interface SwitchBackendRequest {
  backend: AgentBackend;
}

export interface SwitchBackendResult {
  session: Session;
  previousBackend: AgentBackend;
  activeBackend: AgentBackend;
  handoffPromptLength: number;
  inactiveBackendParked: boolean;
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

export interface SessionInternalAuth {
  workerToken: string | null;
  channelToken: string | null;
}

export interface WorkerRegistration {
  workerId: string;
  port: number;
  pid: number;
  claudePid: number | null;
  activeBackend: AgentBackend;
  terminalHandle: string | null;
  terminalBackend: TerminalBackend;
  workerStatus: WorkerStatus;
}

export interface WorkerStateFile {
  sessionId: string;
  workerId: string;
  port: number | null;
  pid: number | null;
  claudePid: number | null;
  activeBackend: AgentBackend;
  terminalBackend: TerminalBackend;
  terminalHandle: string | null;
  workerStatus: WorkerStatus;
  ready: boolean;
  updatedAt: number;
  stdoutLogPath: string;
  stderrLogPath: string;
  terminalLogPath: string;
  lastError: string | null;
  exitCode: number | null;
}

export interface WorkerStartResult {
  ready: boolean;
  error?: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  terminalLogPath: string;
}

export interface WorkerHeartbeat {
  workerId: string;
  port: number;
  pid: number;
  claudePid: number | null;
  activeBackend: AgentBackend;
  terminalHandle: string | null;
  terminalBackend: TerminalBackend;
  workerStatus: WorkerStatus;
}

export interface WorkerNoticePayload {
  message: string;
}

export interface ChannelQueuedEvent {
  content: string;
  meta: Record<string, string>;
}

export interface ChannelReplyPayload {
  chatId: string;
  message: string;
}

export interface ChannelReactionPayload {
  chatId: string;
  messageId: string;
  emoji: string;
}

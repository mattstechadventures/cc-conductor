import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import type {
  IndicatorMode,
  Session,
  SessionInternalAuth,
  SessionStatus,
  TerminalBackend,
  TransportKind,
  TransportState,
  WorkerStatus,
} from './types.js';
import { logger } from './logger.js';
import { ensureDataRoot } from './state.js';
import { getLegacySessionSchemaError, hasLegacyTmuxSessionConstraint } from './session-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '..', 'data', 'conductor.db');

let db: Database.Database;

export function initDb(): void {
  ensureDataRoot();
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      discord_channel_id TEXT NOT NULL,
      discord_channel_name TEXT NOT NULL,
      tmux_session TEXT,
      project_dir TEXT NOT NULL,
      additional_dirs TEXT NOT NULL DEFAULT '[]',
      pid INTEGER,
      status TEXT NOT NULL DEFAULT 'starting',
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      last_checkpoint_at INTEGER,
      checkpoint_path TEXT,
      resume_count INTEGER NOT NULL DEFAULT 0,
      interrupted_at INTEGER,
      indicator_mode TEXT,
      worker_id TEXT,
      terminal_backend TEXT NOT NULL DEFAULT 'pty',
      terminal_handle TEXT,
      transport_kind TEXT NOT NULL DEFAULT 'channel',
      transport_state TEXT NOT NULL DEFAULT 'disconnected',
      claude_session_name TEXT NOT NULL DEFAULT '',
      claude_resume_ref TEXT,
      worker_status TEXT NOT NULL DEFAULT 'stopped',
      worker_token TEXT,
      channel_token TEXT
    );
  `);

  assertCompatibleSessionSchema();
  runMigrations();
  logger.info('Database initialized', DB_PATH);
}

function assertCompatibleSessionSchema(): void {
  const rows = db.prepare('PRAGMA table_info(sessions)').all() as Array<{
    name: string;
    notnull: number;
  }>;

  if (hasLegacyTmuxSessionConstraint(rows)) {
    throw new Error(getLegacySessionSchemaError());
  }
}

function runMigrations(): void {
  const expectedColumns: Record<string, string> = {
    id: 'TEXT',
    name: 'TEXT',
    discord_channel_id: 'TEXT',
    discord_channel_name: 'TEXT',
    tmux_session: 'TEXT',
    project_dir: 'TEXT',
    additional_dirs: "TEXT DEFAULT '[]'",
    pid: 'INTEGER',
    status: 'TEXT',
    created_at: 'INTEGER',
    last_active_at: 'INTEGER',
    last_checkpoint_at: 'INTEGER',
    checkpoint_path: 'TEXT',
    resume_count: 'INTEGER DEFAULT 0',
    interrupted_at: 'INTEGER',
    indicator_mode: 'TEXT',
    worker_id: 'TEXT',
    terminal_backend: "TEXT DEFAULT 'pty'",
    terminal_handle: 'TEXT',
    transport_kind: "TEXT DEFAULT 'channel'",
    transport_state: "TEXT DEFAULT 'disconnected'",
    claude_session_name: "TEXT DEFAULT ''",
    claude_resume_ref: 'TEXT',
    worker_status: "TEXT DEFAULT 'stopped'",
    worker_token: 'TEXT',
    channel_token: 'TEXT',
  };

  const existingColumns = new Set(
    db.prepare('PRAGMA table_info(sessions)').all().map((row: any) => row.name as string)
  );

  for (const [col, type] of Object.entries(expectedColumns)) {
    if (!existingColumns.has(col)) {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${col} ${type}`);
      logger.info(`Migration: added column ${col} ${type}`);
    }
  }

  db.exec(`
    UPDATE sessions
    SET claude_session_name = CASE
      WHEN claude_session_name IS NULL OR claude_session_name = '' THEN name
      ELSE claude_session_name
    END
  `);

  db.exec(`
    UPDATE sessions
    SET claude_resume_ref = CASE
      WHEN claude_resume_ref IS NULL OR claude_resume_ref = '' THEN claude_session_name
      ELSE claude_resume_ref
    END
  `);

  db.exec(`
    UPDATE sessions
    SET terminal_handle = CASE
      WHEN terminal_handle IS NULL OR terminal_handle = '' THEN tmux_session
      ELSE terminal_handle
    END
  `);

  db.exec(`
    UPDATE sessions
    SET terminal_backend = CASE
      WHEN tmux_session IS NOT NULL AND tmux_session != '' AND (worker_id IS NULL OR worker_id = '') THEN 'tmux'
      ELSE terminal_backend
    END
  `);

  db.exec(`
    UPDATE sessions
    SET transport_kind = CASE
      WHEN terminal_backend = 'tmux' AND (transport_kind IS NULL OR transport_kind = '') THEN 'tmux_polling'
      ELSE transport_kind
    END
  `);
}

function rowToSession(row: any): Session {
  const claudeSessionName = row.claude_session_name || row.name;
  return {
    id: row.id,
    name: row.name,
    discordChannelId: row.discord_channel_id,
    discordChannelName: row.discord_channel_name,
    tmuxSession: row.tmux_session ?? null,
    projectDir: row.project_dir,
    additionalDirs: parseAdditionalDirs(row.additional_dirs),
    pid: row.pid ?? null,
    status: row.status as SessionStatus,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    lastCheckpointAt: row.last_checkpoint_at ?? null,
    checkpointPath: row.checkpoint_path ?? null,
    resumeCount: row.resume_count ?? 0,
    interruptedAt: row.interrupted_at ?? null,
    indicatorMode: (row.indicator_mode as IndicatorMode) ?? null,
    workerId: row.worker_id ?? null,
    terminalBackend: (row.terminal_backend as TerminalBackend) || 'pty',
    terminalHandle: row.terminal_handle ?? null,
    transportKind: (row.transport_kind as TransportKind) || 'channel',
    transportState: (row.transport_state as TransportState) || 'disconnected',
    claudeSessionName,
    claudeResumeRef: row.claude_resume_ref ?? claudeSessionName,
    workerStatus: (row.worker_status as WorkerStatus) || 'stopped',
  };
}

export function createSession(session: Session): void {
  db.prepare(`
    INSERT INTO sessions (
      id, name, discord_channel_id, discord_channel_name, tmux_session,
      project_dir, additional_dirs, pid, status, created_at, last_active_at,
      last_checkpoint_at, checkpoint_path, resume_count, interrupted_at,
      indicator_mode, worker_id, terminal_backend, terminal_handle,
      transport_kind, transport_state, claude_session_name, claude_resume_ref,
      worker_status
    ) VALUES (
      @id, @name, @discordChannelId, @discordChannelName, @tmuxSession,
      @projectDir, @additionalDirs, @pid, @status, @createdAt, @lastActiveAt,
      @lastCheckpointAt, @checkpointPath, @resumeCount, @interruptedAt,
      @indicatorMode, @workerId, @terminalBackend, @terminalHandle,
      @transportKind, @transportState, @claudeSessionName, @claudeResumeRef,
      @workerStatus
    )
  `).run({
    id: session.id,
    name: session.name,
    discordChannelId: session.discordChannelId,
    discordChannelName: session.discordChannelName,
    tmuxSession: session.tmuxSession,
    projectDir: session.projectDir,
    additionalDirs: JSON.stringify(session.additionalDirs),
    pid: session.pid,
    status: session.status,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    lastCheckpointAt: session.lastCheckpointAt,
    checkpointPath: session.checkpointPath,
    resumeCount: session.resumeCount,
    interruptedAt: session.interruptedAt,
    indicatorMode: session.indicatorMode,
    workerId: session.workerId,
    terminalBackend: session.terminalBackend,
    terminalHandle: session.terminalHandle,
    transportKind: session.transportKind,
    transportState: session.transportState,
    claudeSessionName: session.claudeSessionName,
    claudeResumeRef: session.claudeResumeRef,
    workerStatus: session.workerStatus,
  });
}

export function getSession(id: string): Session | null {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  return row ? rowToSession(row) : null;
}

export function getSessionByName(name: string): Session | null {
  const row = db.prepare('SELECT * FROM sessions WHERE name = ?').get(name);
  return row ? rowToSession(row) : null;
}

export function getSessionByChannelId(channelId: string): Session | null {
  const row = db.prepare('SELECT * FROM sessions WHERE discord_channel_id = ?').get(channelId);
  return row ? rowToSession(row) : null;
}

export function getAllSessions(): Session[] {
  return db.prepare('SELECT * FROM sessions ORDER BY created_at DESC').all().map(rowToSession);
}

export function getActiveSessions(): Session[] {
  return db.prepare("SELECT * FROM sessions WHERE status IN ('starting', 'active', 'idle') ORDER BY created_at DESC")
    .all().map(rowToSession);
}

export function getInterruptedSessions(): Session[] {
  return db.prepare("SELECT * FROM sessions WHERE status = 'interrupted' ORDER BY interrupted_at DESC")
    .all().map(rowToSession);
}

export function updateSessionStatus(id: string, status: SessionStatus, pid?: number | null): void {
  if (pid !== undefined) {
    db.prepare('UPDATE sessions SET status = ?, pid = ?, last_active_at = ? WHERE id = ?')
      .run(status, pid, Date.now(), id);
  } else {
    db.prepare('UPDATE sessions SET status = ?, last_active_at = ? WHERE id = ?')
      .run(status, Date.now(), id);
  }
}

export function updateSessionActivity(id: string): void {
  db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(Date.now(), id);
}

export function updateCheckpoint(id: string, checkpointPath: string): void {
  db.prepare('UPDATE sessions SET checkpoint_path = ?, last_checkpoint_at = ? WHERE id = ?')
    .run(checkpointPath, Date.now(), id);
}

export function incrementResumeCount(id: string): void {
  db.prepare('UPDATE sessions SET resume_count = resume_count + 1 WHERE id = ?').run(id);
}

export function updateSessionIndicatorMode(id: string, mode: IndicatorMode | null): void {
  db.prepare('UPDATE sessions SET indicator_mode = ? WHERE id = ?').run(mode, id);
}

export function updateSessionAdditionalDirs(id: string, additionalDirs: string[]): void {
  db.prepare('UPDATE sessions SET additional_dirs = ? WHERE id = ?')
    .run(JSON.stringify(additionalDirs), id);
}

export function updateSessionRuntime(
  id: string,
  patch: Partial<Pick<
    Session,
    | 'workerId'
    | 'terminalBackend'
    | 'terminalHandle'
    | 'transportKind'
    | 'transportState'
    | 'claudeSessionName'
    | 'claudeResumeRef'
    | 'workerStatus'
    | 'tmuxSession'
    | 'pid'
  >>
): void {
  const updates: string[] = [];
  const values: unknown[] = [];
  const fieldMap: Record<string, string> = {
    workerId: 'worker_id',
    terminalBackend: 'terminal_backend',
    terminalHandle: 'terminal_handle',
    transportKind: 'transport_kind',
    transportState: 'transport_state',
    claudeSessionName: 'claude_session_name',
    claudeResumeRef: 'claude_resume_ref',
    workerStatus: 'worker_status',
    tmuxSession: 'tmux_session',
    pid: 'pid',
  };

  for (const [key, column] of Object.entries(fieldMap)) {
    const value = patch[key as keyof typeof patch];
    if (value !== undefined) {
      updates.push(`${column} = ?`);
      values.push(value);
    }
  }

  if (updates.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE sessions SET ${updates.join(', ')} WHERE id = ?`).run(...values);
}

export function markInterrupted(id: string): void {
  db.prepare(`
    UPDATE sessions
    SET status = 'interrupted',
        interrupted_at = ?,
        transport_state = 'disconnected',
        worker_status = 'stopped',
        pid = NULL
    WHERE id = ?
  `).run(Date.now(), id);
}

export function deleteSession(id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function setSessionInternalAuth(id: string, auth: SessionInternalAuth): void {
  db.prepare('UPDATE sessions SET worker_token = ?, channel_token = ? WHERE id = ?')
    .run(auth.workerToken, auth.channelToken, id);
}

export function getSessionInternalAuth(id: string): SessionInternalAuth | null {
  const row = db.prepare('SELECT worker_token, channel_token FROM sessions WHERE id = ?').get(id) as any;
  if (!row) return null;
  return {
    workerToken: row.worker_token ?? null,
    channelToken: row.channel_token ?? null,
  };
}

export function closeDb(): void {
  if (db) {
    db.close();
    logger.info('Database closed');
  }
}

function parseAdditionalDirs(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

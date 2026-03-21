import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { ALL_AGENT_BACKENDS, getBackendAdapter, isAgentBackend } from './agent-backends.js';
import type {
  AgentBackend,
  BackendState,
  IndicatorMode,
  Session,
  SessionBackend,
  SessionBackendSummary,
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
      active_backend TEXT NOT NULL DEFAULT 'claude',
      claude_session_name TEXT NOT NULL DEFAULT '',
      claude_resume_ref TEXT,
      worker_status TEXT NOT NULL DEFAULT 'stopped',
      worker_token TEXT,
      channel_token TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_backends (
      session_id TEXT NOT NULL,
      backend TEXT NOT NULL,
      native_session_name TEXT,
      native_resume_ref TEXT,
      state TEXT NOT NULL DEFAULT 'never_started',
      last_active_at INTEGER,
      last_handoff_at INTEGER,
      PRIMARY KEY (session_id, backend),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
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
    active_backend: "TEXT DEFAULT 'claude'",
    claude_session_name: "TEXT DEFAULT ''",
    claude_resume_ref: 'TEXT',
    worker_status: "TEXT DEFAULT 'stopped'",
    worker_token: 'TEXT',
    channel_token: 'TEXT',
  };

  const existingColumns = new Set(
    db.prepare('PRAGMA table_info(sessions)').all().map((row: any) => row.name as string)
  );

  for (const [column, columnType] of Object.entries(expectedColumns)) {
    if (!existingColumns.has(column)) {
      db.exec(`ALTER TABLE sessions ADD COLUMN ${column} ${columnType}`);
      logger.info(`Migration: added column ${column} ${columnType}`);
    }
  }

  db.exec(`
    UPDATE sessions
    SET active_backend = CASE
      WHEN active_backend IN ('claude', 'codex') THEN active_backend
      ELSE 'claude'
    END
  `);

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

  ensureSessionBackendRows();
}

function ensureSessionBackendRows(): void {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO session_backends (
      session_id, backend, native_session_name, native_resume_ref, state, last_active_at, last_handoff_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const rows = db.prepare(`
    SELECT id, name, active_backend, claude_session_name, claude_resume_ref, created_at, last_active_at
    FROM sessions
  `).all() as Array<{
    id: string;
    name: string;
    active_backend: string;
    claude_session_name: string | null;
    claude_resume_ref: string | null;
    created_at: number;
    last_active_at: number;
  }>;

  for (const row of rows) {
    const activeBackend = isAgentBackend(row.active_backend) ? row.active_backend : 'claude';
    const claudeSessionName = row.claude_session_name || row.name;
    const claudeResumeRef = row.claude_resume_ref || claudeSessionName;

    insert.run(
      row.id,
      'claude',
      claudeSessionName,
      claudeResumeRef,
      activeBackend === 'claude' ? 'active' : 'parked',
      row.last_active_at || row.created_at,
      null
    );

    insert.run(
      row.id,
      'codex',
      null,
      null,
      activeBackend === 'codex' ? 'active' : 'never_started',
      activeBackend === 'codex' ? (row.last_active_at || row.created_at) : null,
      null
    );
  }

  db.exec(`
    UPDATE session_backends
    SET native_session_name = CASE
      WHEN backend = 'claude' AND (native_session_name IS NULL OR native_session_name = '') THEN (
        SELECT CASE
          WHEN sessions.claude_session_name IS NULL OR sessions.claude_session_name = '' THEN sessions.name
          ELSE sessions.claude_session_name
        END
        FROM sessions
        WHERE sessions.id = session_backends.session_id
      )
      ELSE native_session_name
    END
  `);

  db.exec(`
    UPDATE session_backends
    SET native_resume_ref = CASE
      WHEN backend = 'claude' AND (native_resume_ref IS NULL OR native_resume_ref = '') THEN (
        SELECT CASE
          WHEN sessions.claude_resume_ref IS NULL OR sessions.claude_resume_ref = '' THEN
            CASE
              WHEN sessions.claude_session_name IS NULL OR sessions.claude_session_name = '' THEN sessions.name
              ELSE sessions.claude_session_name
            END
          ELSE sessions.claude_resume_ref
        END
        FROM sessions
        WHERE sessions.id = session_backends.session_id
      )
      ELSE native_resume_ref
    END
  `);

  normalizeSessionBackendStates();
}

function normalizeSessionBackendStates(): void {
  const sessions = db.prepare('SELECT id, active_backend FROM sessions').all() as Array<{
    id: string;
    active_backend: string;
  }>;

  for (const row of sessions) {
    const activeBackend = isAgentBackend(row.active_backend) ? row.active_backend : 'claude';
    for (const backend of ALL_AGENT_BACKENDS) {
      const summary = getSessionBackend(row.id, backend);
      if (!summary) {
        continue;
      }

      const state = backend === activeBackend
        ? 'active'
        : inferInactiveBackendState(summary);
      updateSessionBackend(row.id, backend, { state });
    }
  }
}

function inferInactiveBackendState(summary: SessionBackendSummary): BackendState {
  if (summary.backend === 'claude' && (summary.nativeSessionName || summary.nativeResumeRef)) {
    return 'parked';
  }
  return summary.resumable || summary.lastActiveAt !== null ? 'parked' : 'never_started';
}

function rowToSession(row: any): Session {
  const activeBackend = isAgentBackend(row.active_backend) ? row.active_backend : 'claude';
  const claudeSessionName = row.claude_session_name || row.name;
  const backendStates = getSessionBackends(row.id);

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
    activeBackend,
    backendStates,
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
      transport_kind, transport_state, active_backend, claude_session_name, claude_resume_ref,
      worker_status
    ) VALUES (
      @id, @name, @discordChannelId, @discordChannelName, @tmuxSession,
      @projectDir, @additionalDirs, @pid, @status, @createdAt, @lastActiveAt,
      @lastCheckpointAt, @checkpointPath, @resumeCount, @interruptedAt,
      @indicatorMode, @workerId, @terminalBackend, @terminalHandle,
      @transportKind, @transportState, @activeBackend, @claudeSessionName, @claudeResumeRef,
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
    activeBackend: session.activeBackend,
    claudeSessionName: session.claudeSessionName,
    claudeResumeRef: session.claudeResumeRef,
    workerStatus: session.workerStatus,
  });

  for (const backend of resolveInitialSessionBackends(session)) {
    upsertSessionBackend(backend);
  }
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

export function getSessionBackends(sessionId: string): SessionBackendSummary[] {
  const rows = db.prepare(`
    SELECT session_id, backend, native_session_name, native_resume_ref, state, last_active_at, last_handoff_at
    FROM session_backends
    WHERE session_id = ?
    ORDER BY backend ASC
  `).all(sessionId) as Array<{
    session_id: string;
    backend: string;
    native_session_name: string | null;
    native_resume_ref: string | null;
    state: string;
    last_active_at: number | null;
    last_handoff_at: number | null;
  }>;

  const byBackend = new Map<AgentBackend, SessionBackendSummary>();
  for (const row of rows) {
    if (!isAgentBackend(row.backend)) {
      continue;
    }
    const summary = toSessionBackendSummary({
      sessionId: row.session_id,
      backend: row.backend,
      nativeSessionName: row.native_session_name,
      nativeResumeRef: row.native_resume_ref,
      state: normalizeBackendState(row.state),
      lastActiveAt: row.last_active_at,
      lastHandoffAt: row.last_handoff_at,
    });
    byBackend.set(summary.backend, summary);
  }

  for (const backend of ALL_AGENT_BACKENDS) {
    if (!byBackend.has(backend)) {
      byBackend.set(backend, toSessionBackendSummary({
        sessionId,
        backend,
        nativeSessionName: backend === 'claude' ? null : null,
        nativeResumeRef: null,
        state: 'never_started',
        lastActiveAt: null,
        lastHandoffAt: null,
      }));
    }
  }

  return ALL_AGENT_BACKENDS.map(backend => byBackend.get(backend)!);
}

export function getSessionBackend(
  sessionId: string,
  backend: AgentBackend
): SessionBackendSummary | null {
  return getSessionBackends(sessionId).find(summary => summary.backend === backend) || null;
}

export function upsertSessionBackend(sessionBackend: SessionBackend): void {
  db.prepare(`
    INSERT INTO session_backends (
      session_id, backend, native_session_name, native_resume_ref, state, last_active_at, last_handoff_at
    ) VALUES (
      @sessionId, @backend, @nativeSessionName, @nativeResumeRef, @state, @lastActiveAt, @lastHandoffAt
    )
    ON CONFLICT(session_id, backend) DO UPDATE SET
      native_session_name = excluded.native_session_name,
      native_resume_ref = excluded.native_resume_ref,
      state = excluded.state,
      last_active_at = excluded.last_active_at,
      last_handoff_at = excluded.last_handoff_at
  `).run({
    sessionId: sessionBackend.sessionId,
    backend: sessionBackend.backend,
    nativeSessionName: sessionBackend.nativeSessionName,
    nativeResumeRef: sessionBackend.nativeResumeRef,
    state: sessionBackend.state,
    lastActiveAt: sessionBackend.lastActiveAt,
    lastHandoffAt: sessionBackend.lastHandoffAt,
  });

  if (sessionBackend.backend === 'claude') {
    db.prepare(`
      UPDATE sessions
      SET claude_session_name = ?,
          claude_resume_ref = ?
      WHERE id = ?
    `).run(
      sessionBackend.nativeSessionName || '',
      sessionBackend.nativeResumeRef,
      sessionBackend.sessionId
    );
  }
}

export function updateSessionBackend(
  sessionId: string,
  backend: AgentBackend,
  patch: Partial<Pick<SessionBackend, 'nativeSessionName' | 'nativeResumeRef' | 'state' | 'lastActiveAt' | 'lastHandoffAt'>>
): void {
  const current = getSessionBackend(sessionId, backend);
  if (!current) {
    const session = getSession(sessionId);
    if (!session) return;
    upsertSessionBackend({
      sessionId,
      backend,
      nativeSessionName: patch.nativeSessionName ?? (backend === 'claude' ? session.claudeSessionName : null),
      nativeResumeRef: patch.nativeResumeRef ?? (backend === 'claude' ? session.claudeResumeRef : null),
      state: patch.state ?? (session.activeBackend === backend ? 'active' : 'never_started'),
      lastActiveAt: patch.lastActiveAt ?? null,
      lastHandoffAt: patch.lastHandoffAt ?? null,
    });
    return;
  }

  upsertSessionBackend({
    sessionId,
    backend,
    nativeSessionName: patch.nativeSessionName !== undefined ? patch.nativeSessionName : current.nativeSessionName,
    nativeResumeRef: patch.nativeResumeRef !== undefined ? patch.nativeResumeRef : current.nativeResumeRef,
    state: patch.state !== undefined ? patch.state : current.state,
    lastActiveAt: patch.lastActiveAt !== undefined ? patch.lastActiveAt : current.lastActiveAt,
    lastHandoffAt: patch.lastHandoffAt !== undefined ? patch.lastHandoffAt : current.lastHandoffAt,
  });
}

export function setSessionActiveBackend(id: string, backend: AgentBackend): void {
  db.prepare('UPDATE sessions SET active_backend = ? WHERE id = ?').run(backend, id);
}

export function markBackendActive(id: string, backend: AgentBackend, at = Date.now()): void {
  setSessionActiveBackend(id, backend);
  updateSessionBackend(id, backend, {
    state: 'active',
    lastActiveAt: at,
  });

  for (const otherBackend of ALL_AGENT_BACKENDS) {
    if (otherBackend === backend) continue;
    const summary = getSessionBackend(id, otherBackend);
    if (!summary) continue;
    updateSessionBackend(id, otherBackend, {
      state: inferInactiveBackendState(summary),
    });
  }
}

export function parkBackend(
  id: string,
  backend: AgentBackend,
  at = Date.now()
): void {
  const summary = getSessionBackend(id, backend);
  if (!summary) return;
  updateSessionBackend(id, backend, {
    state: inferInactiveBackendState({
      ...summary,
      lastActiveAt: summary.lastActiveAt ?? at,
    }),
    lastActiveAt: summary.lastActiveAt ?? at,
  });
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
  const now = Date.now();
  db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(now, id);
  const session = getSession(id);
  if (session) {
    updateSessionBackend(id, session.activeBackend, {
      lastActiveAt: now,
    });
  }
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

function resolveInitialSessionBackends(session: Session): SessionBackend[] {
  const provided = new Map(
    session.backendStates.map(summary => [summary.backend, summary] as const)
  );
  const now = session.lastActiveAt || session.createdAt || Date.now();

  return ALL_AGENT_BACKENDS.map((backend) => {
    const summary = provided.get(backend);
    if (summary) {
      return {
        sessionId: session.id,
        backend,
        nativeSessionName: summary.nativeSessionName,
        nativeResumeRef: summary.nativeResumeRef,
        state: summary.state,
        lastActiveAt: summary.lastActiveAt,
        lastHandoffAt: summary.lastHandoffAt,
      };
    }

    if (backend === 'claude') {
      return {
        sessionId: session.id,
        backend,
        nativeSessionName: session.claudeSessionName || session.name,
        nativeResumeRef: session.claudeResumeRef || session.claudeSessionName || session.name,
        state: session.activeBackend === 'claude' ? 'active' : 'never_started',
        lastActiveAt: session.activeBackend === 'claude' ? now : null,
        lastHandoffAt: null,
      };
    }

    return {
      sessionId: session.id,
      backend,
      nativeSessionName: null,
      nativeResumeRef: null,
      state: session.activeBackend === 'codex' ? 'active' : 'never_started',
      lastActiveAt: session.activeBackend === 'codex' ? now : null,
      lastHandoffAt: null,
    };
  });
}

function toSessionBackendSummary(row: SessionBackend): SessionBackendSummary {
  const summary: SessionBackendSummary = {
    ...row,
    resumable: false,
  };
  summary.resumable = getBackendAdapter(summary.backend).isResumable(summary);
  return summary;
}

function normalizeBackendState(value: string): BackendState {
  return value === 'active' || value === 'parked' ? value : 'never_started';
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

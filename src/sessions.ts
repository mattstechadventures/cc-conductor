import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Session, SessionStatus, IndicatorMode } from './types.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '..', 'data', 'conductor.db');

let db: Database.Database;

export function initDb(): void {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      discord_channel_id TEXT NOT NULL,
      discord_channel_name TEXT NOT NULL,
      tmux_session TEXT NOT NULL,
      project_dir TEXT NOT NULL,
      pid INTEGER,
      status TEXT NOT NULL DEFAULT 'starting',
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      last_checkpoint_at INTEGER,
      checkpoint_path TEXT,
      resume_count INTEGER NOT NULL DEFAULT 0,
      interrupted_at INTEGER
    );
  `);

  runMigrations();
  logger.info('Database initialized', DB_PATH);
}

function runMigrations(): void {
  const expectedColumns: Record<string, string> = {
    id: 'TEXT',
    name: 'TEXT',
    discord_channel_id: 'TEXT',
    discord_channel_name: 'TEXT',
    tmux_session: 'TEXT',
    project_dir: 'TEXT',
    pid: 'INTEGER',
    status: 'TEXT',
    created_at: 'INTEGER',
    last_active_at: 'INTEGER',
    last_checkpoint_at: 'INTEGER',
    checkpoint_path: 'TEXT',
    resume_count: 'INTEGER',
    interrupted_at: 'INTEGER',
    indicator_mode: 'TEXT',
  };

  const existingColumns = new Set(
    db.prepare('PRAGMA table_info(sessions)').all()
      .map((row: any) => row.name as string)
  );

  for (const [col, type] of Object.entries(expectedColumns)) {
    if (!existingColumns.has(col)) {
      const defaultVal = type === 'INTEGER' ? 'DEFAULT 0' : '';
      db.exec(`ALTER TABLE sessions ADD COLUMN ${col} ${type} ${defaultVal}`);
      logger.info(`Migration: added column ${col} ${type}`);
    }
  }
}

function rowToSession(row: any): Session {
  return {
    id: row.id,
    name: row.name,
    discordChannelId: row.discord_channel_id,
    discordChannelName: row.discord_channel_name,
    tmuxSession: row.tmux_session,
    projectDir: row.project_dir,
    pid: row.pid ?? null,
    status: row.status as SessionStatus,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    lastCheckpointAt: row.last_checkpoint_at ?? null,
    checkpointPath: row.checkpoint_path ?? null,
    resumeCount: row.resume_count ?? 0,
    interruptedAt: row.interrupted_at ?? null,
    indicatorMode: (row.indicator_mode as IndicatorMode) ?? null,
  };
}

export function createSession(session: Session): void {
  db.prepare(`
    INSERT INTO sessions (
      id, name, discord_channel_id, discord_channel_name, tmux_session,
      project_dir, pid, status, created_at, last_active_at,
      last_checkpoint_at, checkpoint_path, resume_count, interrupted_at,
      indicator_mode
    ) VALUES (
      @id, @name, @discordChannelId, @discordChannelName, @tmuxSession,
      @projectDir, @pid, @status, @createdAt, @lastActiveAt,
      @lastCheckpointAt, @checkpointPath, @resumeCount, @interruptedAt,
      @indicatorMode
    )
  `).run({
    id: session.id,
    name: session.name,
    discordChannelId: session.discordChannelId,
    discordChannelName: session.discordChannelName,
    tmuxSession: session.tmuxSession,
    projectDir: session.projectDir,
    pid: session.pid,
    status: session.status,
    createdAt: session.createdAt,
    lastActiveAt: session.lastActiveAt,
    lastCheckpointAt: session.lastCheckpointAt,
    checkpointPath: session.checkpointPath,
    resumeCount: session.resumeCount,
    interruptedAt: session.interruptedAt,
    indicatorMode: session.indicatorMode,
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

export function updateSessionStatus(id: string, status: SessionStatus, pid?: number): void {
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

export function updateCheckpoint(id: string, path: string): void {
  db.prepare('UPDATE sessions SET checkpoint_path = ?, last_checkpoint_at = ? WHERE id = ?')
    .run(path, Date.now(), id);
}

export function markInterrupted(id: string): void {
  db.prepare("UPDATE sessions SET status = 'interrupted', interrupted_at = ? WHERE id = ?")
    .run(Date.now(), id);
}

export function incrementResumeCount(id: string): void {
  db.prepare('UPDATE sessions SET resume_count = resume_count + 1 WHERE id = ?').run(id);
}

export function updateSessionIndicatorMode(id: string, mode: IndicatorMode | null): void {
  db.prepare('UPDATE sessions SET indicator_mode = ? WHERE id = ?').run(mode, id);
}

export function deleteSession(id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function closeDb(): void {
  if (db) {
    db.close();
    logger.info('Database closed');
  }
}

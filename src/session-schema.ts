export interface SessionTableInfoRow {
  name: string;
  notnull: number;
}

export function hasLegacyTmuxSessionConstraint(rows: SessionTableInfoRow[]): boolean {
  const tmuxSession = rows.find(row => row.name === 'tmux_session');
  return tmuxSession?.notnull === 1;
}

export function getLegacySessionSchemaError(): string {
  return [
    'Legacy session database detected: sessions.tmux_session is still NOT NULL.',
    'Reset the database manually by deleting data/conductor.db, data/conductor.db-shm, and data/conductor.db-wal, then restart Conductor.',
  ].join(' ');
}

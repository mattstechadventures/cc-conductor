import type { Session } from './types.js';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

/**
 * Build the claude command for a session.
 * Conductor's bridge handles Discord relay via tmux I/O.
 */
export function buildClaudeCommand(session: Session): string {
  // acceptEdits: auto-accepts file edits without prompting, no scary confirmation
  return `${CLAUDE_BIN} --permission-mode acceptEdits`;
}

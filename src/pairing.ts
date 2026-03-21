import type { Session } from './types.js';

/**
 * Build the claude command for a session.
 * Plain interactive claude — the bridge module handles Discord relay via tmux I/O.
 */
export function buildClaudeCommand(session: Session): string {
  // Start claude in the project directory (tmux session is already cd'd there)
  // Use --dangerously-skip-permissions so Claude can work unattended
  return 'claude --dangerously-skip-permissions';
}

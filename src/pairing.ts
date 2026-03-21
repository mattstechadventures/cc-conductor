import { getSessionChannelServerName } from './claude-mcp.js';
import type { Session, WorkerLaunchMode } from './types.js';

export interface ClaudeLaunchPlan {
  command: string;
  args: string[];
}

export function buildClaudeLaunch(
  session: Session,
  options: {
    mode: WorkerLaunchMode;
    structuredTransport: boolean;
  }
): ClaudeLaunchPlan {
  const args: string[] = [];

  if (options.mode === 'resume') {
    args.push('--resume', session.claudeResumeRef || session.claudeSessionName);
  } else {
    args.push('--name', session.claudeSessionName);
  }

  args.push('--permission-mode', 'acceptEdits');

  for (const directory of session.additionalDirs) {
    args.push('--add-dir', directory);
  }

  if (options.structuredTransport) {
    args.push(
      '--dangerously-load-development-channels',
      `server:${getSessionChannelServerName(session.id)}`
    );
  }

  return {
    command: process.env.CONDUCTOR_RESOLVED_CLAUDE_BIN || process.env.CLAUDE_BIN || 'claude',
    args,
  };
}

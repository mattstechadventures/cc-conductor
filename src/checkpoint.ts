import { execSync } from 'child_process';
import fs from 'fs';
import { Client } from 'discord.js';
import type { Checkpoint, CheckpointMessage, Session } from './types.js';
import { fetchRecentSessionMessages } from './handoff.js';
import { logger } from './logger.js';
import { updateCheckpoint } from './sessions.js';
import { getCheckpointPath } from './state.js';

export async function writeCheckpoint(session: Session, discordClient: Client): Promise<string> {
  const checkpointPath = getCheckpointPath(session.projectDir);
  const messageCount = parseInt(process.env.CHECKPOINT_DISCORD_MESSAGES || '50', 10);
  const recentMessages = await fetchRecentSessionMessages(session, discordClient, messageCount);
  const { branch: gitBranch, lastCommit: gitLastCommit } = readGitState(session.projectDir);

  const checkpoint: Checkpoint = {
    sessionId: session.id,
    sessionName: session.name,
    projectDir: session.projectDir,
    writtenAt: Date.now(),
    gitBranch,
    gitLastCommit,
    taskSummary: inferTaskSummary(recentMessages),
    recentMessages,
  };

  fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
  updateCheckpoint(session.id, checkpointPath);
  logger.info(`Checkpoint written for session ${session.name}: ${checkpointPath}`);
  return checkpointPath;
}

export function readCheckpoint(session: Session): Checkpoint | null {
  const checkpointPath = getCheckpointPath(session.projectDir);
  try {
    return JSON.parse(fs.readFileSync(checkpointPath, 'utf-8')) as Checkpoint;
  } catch {
    return null;
  }
}

let checkpointTimer: ReturnType<typeof setInterval> | null = null;

export function startCheckpointScheduler(
  getActiveSessions: () => Session[],
  discordClient: Client
): void {
  const intervalMins = parseInt(process.env.CHECKPOINT_INTERVAL_MINS || '15', 10);
  if (intervalMins <= 0) {
    logger.info('Checkpoint scheduler disabled (interval = 0)');
    return;
  }

  checkpointTimer = setInterval(() => {
    void flushAllCheckpoints(getActiveSessions(), discordClient);
  }, intervalMins * 60 * 1000);

  logger.info(`Checkpoint scheduler started: every ${intervalMins} minutes`);
}

export function stopCheckpointScheduler(): void {
  if (checkpointTimer) {
    clearInterval(checkpointTimer);
    checkpointTimer = null;
  }
}

export async function flushAllCheckpoints(sessions: Session[], discordClient: Client): Promise<void> {
  const results = await Promise.allSettled(sessions.map(session => writeCheckpoint(session, discordClient)));
  const failed = results.filter(result => result.status === 'rejected').length;
  if (failed > 0) {
    logger.warn(`${failed}/${sessions.length} checkpoint flushes failed`);
  }
}

function readGitState(dir: string): { branch: string | null; lastCommit: string | null } {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();
    const lastCommit = execSync('git log -1 --oneline', {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 5_000,
    }).trim();
    return { branch, lastCommit };
  } catch {
    return { branch: null, lastCommit: null };
  }
}

function inferTaskSummary(messages: CheckpointMessage[]): string | null {
  if (messages.length === 0) return null;
  const latestClaude = [...messages].reverse().find(message => message.author === 'claude');
  const latestUser = [...messages].reverse().find(message => message.author !== 'claude');

  if (latestClaude && latestUser) {
    return `Latest user request: ${truncate(latestUser.content)}\nLatest Claude reply: ${truncate(latestClaude.content)}`;
  }

  return truncate(messages[messages.length - 1].content);
}

function truncate(text: string, max = 240): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

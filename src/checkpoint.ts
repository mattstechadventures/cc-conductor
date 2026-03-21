import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Client, TextChannel } from 'discord.js';
import type { Session, Checkpoint, CheckpointMessage } from './types.js';
import { updateCheckpoint } from './sessions.js';
import { capturePaneOutput, sendKeys, tmuxSessionExists } from './tmux.js';
import { logger } from './logger.js';

const CHECKPOINT_FILENAME = '.conductor-checkpoint.json';

export async function writeCheckpoint(session: Session, discordClient: Client): Promise<string> {
  const checkpointPath = path.join(session.projectDir, CHECKPOINT_FILENAME);
  const messageCount = parseInt(process.env.CHECKPOINT_DISCORD_MESSAGES || '50', 10);

  // 1. Fetch recent Discord messages
  const recentMessages = await fetchDiscordMessages(session.discordChannelId, discordClient, messageCount);

  // 2. Read git state
  const { branch: gitBranch, lastCommit: gitLastCommit } = readGitState(session.projectDir);

  // 3. Request task summary from Claude (best-effort)
  const taskSummary = await requestTaskSummary(session);

  // 4. Write checkpoint
  const checkpoint: Checkpoint = {
    sessionId: session.id,
    sessionName: session.name,
    projectDir: session.projectDir,
    writtenAt: Date.now(),
    gitBranch,
    gitLastCommit,
    taskSummary,
    recentMessages,
  };

  fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));

  // 5. Update DB
  updateCheckpoint(session.id, checkpointPath);

  logger.info(`Checkpoint written for session ${session.name}: ${checkpointPath}`);
  return checkpointPath;
}

export function readCheckpoint(session: Session): Checkpoint | null {
  const checkpointPath = path.join(session.projectDir, CHECKPOINT_FILENAME);
  try {
    const data = fs.readFileSync(checkpointPath, 'utf-8');
    return JSON.parse(data) as Checkpoint;
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

  checkpointTimer = setInterval(async () => {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      try {
        await writeCheckpoint(session, discordClient);
      } catch (err: any) {
        logger.error(`Checkpoint failed for session ${session.name}: ${err.message}`);
      }
    }
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
  const results = await Promise.allSettled(
    sessions.map(s => writeCheckpoint(s, discordClient))
  );
  const failed = results.filter(r => r.status === 'rejected').length;
  if (failed > 0) {
    logger.warn(`${failed}/${sessions.length} checkpoint flushes failed`);
  }
}

// --- Internal helpers ---

async function fetchDiscordMessages(
  channelId: string,
  client: Client,
  count: number
): Promise<CheckpointMessage[]> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !(channel instanceof TextChannel)) return [];

    const messages = await channel.messages.fetch({ limit: Math.min(count, 100) });
    return messages
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .map(msg => ({
        author: msg.author.bot ? 'claude' : msg.author.displayName || msg.author.username,
        content: msg.content,
        timestamp: msg.createdTimestamp,
      }));
  } catch (err: any) {
    logger.error(`Failed to fetch Discord messages for channel ${channelId}: ${err.message}`);
    return [];
  }
}

function readGitState(dir: string): { branch: string | null; lastCommit: string | null } {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir, encoding: 'utf-8', timeout: 5000 }).trim();
    const lastCommit = execSync('git log -1 --oneline', { cwd: dir, encoding: 'utf-8', timeout: 5000 }).trim();
    return { branch, lastCommit };
  } catch {
    return { branch: null, lastCommit: null };
  }
}

async function requestTaskSummary(session: Session): Promise<string | null> {
  if (!tmuxSessionExists(session.tmuxSession)) return null;

  try {
    // Send the checkpoint prompt
    sendKeys(
      session.tmuxSession,
      '[CONDUCTOR_CHECKPOINT] Summarise in 2-3 sentences what you are currently working on or were last working on.'
    );

    // Wait up to 10 seconds for output
    await new Promise(resolve => setTimeout(resolve, 10_000));

    // Capture pane output and try to extract the summary
    const output = capturePaneOutput(session.tmuxSession, 30);
    if (!output) return null;

    // Look for lines after the checkpoint prompt
    const lines = output.split('\n');
    const promptIdx = lines.findIndex(l => l.includes('[CONDUCTOR_CHECKPOINT]'));
    if (promptIdx === -1) return null;

    const summaryLines = lines
      .slice(promptIdx + 1)
      .filter(l => l.trim() && !l.includes('[CONDUCTOR_CHECKPOINT]'));

    return summaryLines.length > 0 ? summaryLines.join('\n').trim() : null;
  } catch {
    return null;
  }
}

import fs from 'fs';
import path from 'path';
import { Client, TextChannel } from 'discord.js';
import type { Session, Checkpoint, CheckpointMessage, ReconciliationReport, ResumeResult } from './types.js';
import {
  getAllSessions, getSession, markInterrupted, updateSessionStatus,
  incrementResumeCount, deleteSession,
} from './sessions.js';
import {
  tmuxSessionExists, getSessionPid, killTmuxSession, createTmuxSession, sendKeys,
} from './tmux.js';
import { readCheckpoint } from './checkpoint.js';
import { buildClaudeCommand } from './pairing.js';
import { logger } from './logger.js';

const RESUME_PROMPT_FILENAME = '.conductor-resume-prompt.md';

// Case 1: Conductor restarted, tmux session still alive — just reconnect
export async function reattachSession(session: Session, discordClient: Client): Promise<void> {
  // The Claude process is still running in tmux, we just lost our in-memory state.
  // The plugin subprocess should also still be running, but we post a reconnection notice.
  try {
    const channel = await discordClient.channels.fetch(session.discordChannelId) as TextChannel | null;
    if (channel) {
      await channel.send(`↺ Conductor restarted — session **${session.name}** reconnected.`);
    }
  } catch (err: any) {
    logger.error(`Failed to post reattach notice for ${session.name}: ${err.message}`);
  }

  updateSessionStatus(session.id, 'active', getSessionPid(session.tmuxSession) ?? undefined);
  logger.info(`Reattached session: ${session.name}`);
}

// Cases 2 & 3: Full resume with context injection
export async function resumeSession(session: Session, discordClient: Client): Promise<ResumeResult> {
  // 1. Read checkpoint from disk
  const checkpoint = readCheckpoint(session);

  // 2. Fetch recent Discord messages (always — most up-to-date)
  const discordMessages = await fetchRecentMessages(session.discordChannelId, discordClient);

  // 3. Merge checkpoint context + Discord messages (deduplicate by timestamp proximity)
  const checkpointMessages = checkpoint?.recentMessages ?? [];
  const mergedMessages = mergeMessages(checkpointMessages, discordMessages);

  // 4. Build resume prompt
  const resumePrompt = buildResumePrompt(session, checkpoint, mergedMessages);

  // 5. Kill old tmux session if somehow still there
  if (tmuxSessionExists(session.tmuxSession)) {
    killTmuxSession(session.tmuxSession);
  }

  // 6. Create new tmux session
  createTmuxSession(session.tmuxSession, session.projectDir);

  // 7. Write resume prompt file
  const resumePromptPath = path.join(session.projectDir, RESUME_PROMPT_FILENAME);
  fs.writeFileSync(resumePromptPath, resumePrompt);

  // 8. Spawn Claude Code with plugin + resume prompt
  const cmd = buildClaudeCommand(session, resumePromptPath);
  sendKeys(session.tmuxSession, cmd);

  // 9. Update session state
  incrementResumeCount(session.id);
  updateSessionStatus(session.id, 'starting');

  // 10. Post to Discord
  try {
    const channel = await discordClient.channels.fetch(session.discordChannelId) as TextChannel | null;
    const updated = getSession(session.id);
    const resumeNum = updated?.resumeCount ?? session.resumeCount + 1;
    if (channel) {
      await channel.send(`↺ Session **${session.name}** is resuming (resume #${resumeNum})...`);
    }
  } catch (err: any) {
    logger.error(`Failed to post resume notice for ${session.name}: ${err.message}`);
  }

  const updated = getSession(session.id)!;
  return {
    session: updated,
    checkpointUsed: !!checkpoint,
    messagesInjected: mergedMessages.length,
    resumePromptLength: resumePrompt.length,
  };
}

// Reconcile all DB sessions against live tmux sessions and Discord channels
export async function reconcileOnStartup(
  discordClient: Client
): Promise<ReconciliationReport> {
  const sessions = getAllSessions();
  const report: ReconciliationReport = {
    liveAndHealthy: [],
    reattached: [],
    interrupted: [],
    cleaned: [],
  };

  for (const session of sessions) {
    // Check if Discord channel still exists
    let channelExists = false;
    try {
      const channel = await discordClient.channels.fetch(session.discordChannelId);
      channelExists = !!channel;
    } catch {
      channelExists = false;
    }

    if (!channelExists) {
      logger.info(`Session ${session.name}: Discord channel gone — cleaning up`);
      deleteSession(session.id);
      report.cleaned.push(session.name);
      continue;
    }

    // Check tmux session
    const tmuxAlive = tmuxSessionExists(session.tmuxSession);

    if (tmuxAlive) {
      const pid = getSessionPid(session.tmuxSession);
      if (pid) {
        // Case 1: Everything still running
        if (session.status === 'active' || session.status === 'starting') {
          report.liveAndHealthy.push(session.name);
        } else {
          // Was marked interrupted or dead but actually still running
          report.reattached.push(session.name);
        }
        await reattachSession(session, discordClient);
      } else {
        // tmux alive but no process — kill tmux, mark interrupted
        killTmuxSession(session.tmuxSession);
        markInterrupted(session.id);
        report.interrupted.push(session.name);
      }
    } else {
      // tmux session dead — Case 2 or 3
      if (session.status !== 'dead' && session.status !== 'interrupted') {
        markInterrupted(session.id);
        report.interrupted.push(session.name);
      } else if (session.status === 'interrupted') {
        report.interrupted.push(session.name);
      }
    }
  }

  // Post reconciliation summary if anything interesting happened
  if (report.reattached.length > 0 || report.interrupted.length > 0 || report.cleaned.length > 0) {
    const orchName = process.env.ORCHESTRATOR_CHANNEL_NAME || 'orchestrator';
    try {
      const guild = discordClient.guilds.cache.first();
      if (guild) {
        const orchChannel = guild.channels.cache.find(
          c => c.name === orchName && c.isTextBased()
        ) as TextChannel | undefined;

        if (orchChannel) {
          const lines: string[] = ['**Reconciliation report:**'];
          if (report.liveAndHealthy.length > 0) {
            lines.push(`  Healthy: ${report.liveAndHealthy.join(', ')}`);
          }
          if (report.reattached.length > 0) {
            lines.push(`  ↺ Reattached: ${report.reattached.join(', ')}`);
          }
          if (report.interrupted.length > 0) {
            lines.push(`  ⚠ Interrupted (use \`/resume <name>\` to recover): ${report.interrupted.join(', ')}`);
          }
          if (report.cleaned.length > 0) {
            lines.push(`  Cleaned up: ${report.cleaned.join(', ')}`);
          }
          await orchChannel.send(lines.join('\n'));
        }
      }
    } catch (err: any) {
      logger.error(`Failed to post reconciliation report: ${err.message}`);
    }
  }

  logger.info('Reconciliation complete', report);
  return report;
}

// --- Internal helpers ---

function buildResumePrompt(
  session: Session,
  checkpoint: Checkpoint | null,
  messages: CheckpointMessage[]
): string {
  const now = Date.now();
  const interruptedAt = session.interruptedAt ?? checkpoint?.writtenAt ?? now;
  const minutesAgo = Math.round((now - interruptedAt) / 60_000);
  const resumeNum = session.resumeCount + 1;

  const formattedMessages = messages
    .map(m => `${m.author === 'claude' ? 'Claude' : 'User'}: ${m.content}`)
    .join('\n');

  return `[CONDUCTOR RESUME — Session: ${session.name} — Resume #${resumeNum}]

You are resuming a previous Claude Code session that was interrupted.
Project directory: ${session.projectDir}
Originally started: ${new Date(session.createdAt).toISOString()}
Interrupted: ${new Date(interruptedAt).toISOString()} (${minutesAgo} minutes ago)

--- Last known task ---
${checkpoint?.taskSummary || 'No task summary available.'}

--- Git state at checkpoint ---
Branch: ${checkpoint?.gitBranch || 'unknown'}
Last commit: ${checkpoint?.gitLastCommit || 'unknown'}

--- Recent conversation (${messages.length} messages) ---
${formattedMessages || 'No recent messages available.'}

--- End of resume context ---

Please acknowledge you have read the above context and are ready to continue.
State what you understand the current task to be and what your next action will be.
Do not repeat the resume context back verbatim.
`;
}

async function fetchRecentMessages(
  channelId: string,
  client: Client
): Promise<CheckpointMessage[]> {
  const count = parseInt(process.env.CHECKPOINT_DISCORD_MESSAGES || '50', 10);
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
  } catch {
    return [];
  }
}

function mergeMessages(
  checkpointMsgs: CheckpointMessage[],
  discordMsgs: CheckpointMessage[]
): CheckpointMessage[] {
  // Discord messages are the source of truth; checkpoint messages fill gaps
  // Deduplicate by checking timestamp proximity (within 2 seconds)
  const merged = [...discordMsgs];
  const discordTimestamps = new Set(discordMsgs.map(m => m.timestamp));

  for (const msg of checkpointMsgs) {
    const isDuplicate = discordMsgs.some(
      dm => Math.abs(dm.timestamp - msg.timestamp) < 2000 && dm.author === msg.author
    );
    if (!isDuplicate) {
      merged.push(msg);
    }
  }

  return merged.sort((a, b) => a.timestamp - b.timestamp);
}

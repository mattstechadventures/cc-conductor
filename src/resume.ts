import fs from 'fs';
import { Client, TextChannel } from 'discord.js';
import type { Checkpoint, CheckpointMessage, ReconciliationReport, ResumeResult, Session } from './types.js';
import {
  deleteSession,
  getAllSessions,
  getSession,
  incrementResumeCount,
  markInterrupted,
  updateSessionRuntime,
  updateSessionStatus,
} from './sessions.js';
import { readCheckpoint } from './checkpoint.js';
import { startBridge } from './bridge.js';
import { logger } from './logger.js';
import { getWorkerRuntime } from './runtime-state.js';
import { getResumePromptPath } from './state.js';
import { spawnSessionWorker, terminateSessionWorker } from './worker-manager.js';
import { formatCommand } from './command-prefix.js';

export async function reattachSession(session: Session, discordClient: Client): Promise<void> {
  const worker = getWorkerRuntime(session.id);
  updateSessionStatus(session.id, 'active', worker?.claudePid ?? null);
  startBridge(session, discordClient);

  try {
    const channel = await discordClient.channels.fetch(session.discordChannelId) as TextChannel | null;
    if (channel) {
      await channel.send(`↺ Conductor restarted. Session **${session.name}** reconnected.`);
    }
  } catch (err: any) {
    logger.error(`Failed to post reattach notice for ${session.name}: ${err.message}`);
  }
}

export async function resumeSession(session: Session, discordClient: Client): Promise<ResumeResult> {
  return await restartSession(session, discordClient, 'resume');
}

export async function restartSession(
  session: Session,
  discordClient: Client,
  reason: 'resume' | 'directory-access-update' = 'resume'
): Promise<ResumeResult> {
  await terminateSessionWorker(session);
  updateSessionStatus(session.id, 'starting', null);
  updateSessionRuntime(session.id, {
    transportState: 'disconnected',
    workerStatus: 'starting',
  });
  startBridge(session, discordClient);

  if (reason === 'resume') {
    incrementResumeCount(session.id);
  }
  const latestForCli = getSession(session.id) || session;
  const cliResume = await spawnSessionWorker(latestForCli, { mode: 'resume' });
  if (cliResume.ready) {
    if (reason === 'resume') {
      await postResumeNotice(discordClient, latestForCli, 'cli', reason);
    }
    return {
      session: getSession(session.id) || latestForCli,
      checkpointUsed: false,
      messagesInjected: 0,
      resumePromptLength: 0,
      resumeStrategy: 'cli',
    };
  }

  await terminateSessionWorker(session);

  const checkpoint = readCheckpoint(session);
  const discordMessages = await fetchRecentMessages(session.discordChannelId, discordClient);
  const mergedMessages = mergeMessages(checkpoint?.recentMessages ?? [], discordMessages);
  const resumePrompt = buildResumePrompt(session, checkpoint, mergedMessages);
  const resumePromptPath = getResumePromptPath(session.projectDir);
  fs.writeFileSync(resumePromptPath, resumePrompt);

  const latestForPrompt = getSession(session.id) || session;
  const promptResume = await spawnSessionWorker(latestForPrompt, {
    mode: 'resume-prompt',
    resumePromptPath,
  });

  if (!promptResume.ready) {
    markInterrupted(session.id);
    throw new Error(promptResume.error || cliResume.error || 'Failed to resume session with Claude resume and checkpoint fallback');
  }

  if (reason === 'resume') {
    await postResumeNotice(discordClient, latestForPrompt, 'checkpoint', reason);
  }
  return {
    session: getSession(session.id) || latestForPrompt,
    checkpointUsed: !!checkpoint,
    messagesInjected: mergedMessages.length,
    resumePromptLength: resumePrompt.length,
    resumeStrategy: 'checkpoint',
  };
}

export async function reconcileOnStartup(discordClient: Client): Promise<ReconciliationReport> {
  const sessions = getAllSessions();
  const report: ReconciliationReport = {
    liveAndHealthy: [],
    reattached: [],
    interrupted: [],
    cleaned: [],
  };

  for (const session of sessions) {
    let channelExists = false;
    try {
      const channel = await discordClient.channels.fetch(session.discordChannelId);
      channelExists = !!channel;
    } catch {
      channelExists = false;
    }

    if (!channelExists) {
      deleteSession(session.id);
      report.cleaned.push(session.name);
      continue;
    }

    const worker = getWorkerRuntime(session.id);
    if (worker) {
      if (session.status === 'active' || session.status === 'starting' || session.status === 'idle') {
        report.liveAndHealthy.push(session.name);
      } else {
        report.reattached.push(session.name);
      }
      await reattachSession(session, discordClient);
      continue;
    }

    if (session.status !== 'dead' && session.status !== 'interrupted') {
      markInterrupted(session.id);
      report.interrupted.push(session.name);
    } else if (session.status === 'interrupted') {
      report.interrupted.push(session.name);
    }
  }

  if (report.reattached.length > 0 || report.interrupted.length > 0 || report.cleaned.length > 0) {
    await postReconciliationReport(report, discordClient);
  }

  logger.info('Reconciliation complete', report);
  return report;
}

function buildResumePrompt(
  session: Session,
  checkpoint: Checkpoint | null,
  messages: CheckpointMessage[]
): string {
  const now = Date.now();
  const interruptedAt = session.interruptedAt ?? checkpoint?.writtenAt ?? now;
  const minutesAgo = Math.round((now - interruptedAt) / 60_000);
  const resumeNum = getSession(session.id)?.resumeCount ?? (session.resumeCount + 1);

  const formattedMessages = messages
    .map(msg => `${msg.author === 'claude' ? 'Claude' : 'User'}: ${msg.content}`)
    .join('\n');

  return `[CONDUCTOR RESUME - Session: ${session.name} - Resume #${resumeNum}]

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

async function fetchRecentMessages(channelId: string, client: Client): Promise<CheckpointMessage[]> {
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

function mergeMessages(checkpointMessages: CheckpointMessage[], discordMessages: CheckpointMessage[]): CheckpointMessage[] {
  const merged = [...discordMessages];
  for (const checkpointMessage of checkpointMessages) {
    const duplicate = discordMessages.some(
      discordMessage =>
        Math.abs(discordMessage.timestamp - checkpointMessage.timestamp) < 2000 &&
        discordMessage.author === checkpointMessage.author
    );
    if (!duplicate) {
      merged.push(checkpointMessage);
    }
  }
  return merged.sort((a, b) => a.timestamp - b.timestamp);
}

async function postResumeNotice(
  discordClient: Client,
  session: Session,
  strategy: 'cli' | 'checkpoint',
  reason: 'resume' | 'directory-access-update'
): Promise<void> {
  try {
    const channel = await discordClient.channels.fetch(session.discordChannelId) as TextChannel | null;
    if (!channel) return;
    const latest = getSession(session.id) || session;
    const action = reason === 'directory-access-update'
      ? 'is restarting to apply updated directory access'
      : 'is resuming';
    await channel.send(`↺ Session **${session.name}** ${action} (resume #${latest.resumeCount}) via **${strategy}**...`);
  } catch (err: any) {
    logger.error(`Failed to post resume notice for ${session.name}: ${err.message}`);
  }
}

async function postReconciliationReport(report: ReconciliationReport, discordClient: Client): Promise<void> {
  const orchestratorName = process.env.ORCHESTRATOR_CHANNEL_NAME || 'orchestrator';
  try {
    const guild = discordClient.guilds.cache.get(process.env.DISCORD_GUILD_ID!);
    const channel = guild?.channels.cache.find(
      entry => entry.name === orchestratorName && entry.isTextBased()
    ) as TextChannel | undefined;
    if (!channel) return;

    const lines: string[] = ['**Reconciliation report:**'];
    if (report.liveAndHealthy.length > 0) {
      lines.push(`Healthy: ${report.liveAndHealthy.join(', ')}`);
    }
    if (report.reattached.length > 0) {
      lines.push(`Reattached: ${report.reattached.join(', ')}`);
    }
    if (report.interrupted.length > 0) {
      lines.push(`Interrupted (use \`${formatCommand('resume <name>')}\` to recover): ${report.interrupted.join(', ')}`);
    }
    if (report.cleaned.length > 0) {
      lines.push(`Cleaned up: ${report.cleaned.join(', ')}`);
    }
    await channel.send(lines.join('\n'));
  } catch (err: any) {
    logger.error(`Failed to post reconciliation report: ${err.message}`);
  }
}

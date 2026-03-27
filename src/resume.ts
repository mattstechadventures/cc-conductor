import fs from 'fs';
import { Client, TextChannel } from 'discord.js';
import { getBackendAdapter, getBackendDisplayName } from './agent-backends.js';
import { readCheckpoint } from './checkpoint.js';
import { startBridge } from './bridge.js';
import { buildBackendHandoffPrompt, buildResumePrompt, fetchRecentSessionMessages, mergeCheckpointMessages } from './handoff.js';
import { logger } from './logger.js';
import { getRuntimeBuildId } from './runtime-build.js';
import { clearWorkerRuntime, getWorkerRuntime } from './runtime-state.js';
import {
  deleteSession,
  getAllSessions,
  getSession,
  getSessionBackend,
  incrementResumeCount,
  markBackendActive,
  markInterrupted,
  parkBackend,
  setSessionActiveBackend,
  updateSessionBackend,
  updateSessionRuntime,
  updateSessionStatus,
} from './sessions.js';
import { getResumePromptPath } from './state.js';
import { hasCompatibleWorkerRuntime } from './worker-runtime-compat.js';
import { sendInputToWorker, spawnSessionWorker, terminateSessionWorker } from './worker-manager.js';
import { formatCommand } from './command-prefix.js';
import type {
  AgentBackend,
  ReconciliationReport,
  ResumeResult,
  Session,
  SwitchBackendResult,
} from './types.js';

export async function reattachSession(session: Session, discordClient: Client): Promise<void> {
  const worker = getWorkerRuntime(session.id);
  updateSessionStatus(session.id, 'active', worker?.claudePid ?? null);
  startBridge(session, discordClient);

  try {
    const channel = await discordClient.channels.fetch(session.discordChannelId) as TextChannel | null;
    if (channel) {
      await channel.send(
        `↺ CC Conductor restarted. Session **${session.name}** reconnected on **${getBackendDisplayName(session.activeBackend)}**.`
      );
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
  const latest = getSession(session.id) || session;
  return latest.activeBackend === 'codex'
    ? await restartCodexSession(latest, discordClient, reason)
    : await restartClaudeSession(latest, discordClient, reason);
}

export async function switchSessionBackend(
  session: Session,
  targetBackend: AgentBackend,
  discordClient: Client
): Promise<SwitchBackendResult> {
  if (session.activeBackend === targetBackend) {
    return {
      session,
      previousBackend: session.activeBackend,
      activeBackend: targetBackend,
      handoffPromptLength: 0,
      inactiveBackendParked: false,
    };
  }

  const sourceBackend = session.activeBackend;
  const checkpoint = readCheckpoint(session);
  const discordMessages = await fetchRecentSessionMessages(session, discordClient);
  const mergedMessages = mergeCheckpointMessages(checkpoint?.recentMessages ?? [], discordMessages);
  const handoffPrompt = buildBackendHandoffPrompt({
    session,
    checkpoint,
    messages: mergedMessages,
    sourceBackend,
    targetBackend,
  });
  const handoffPromptPath = getResumePromptPath(session.projectDir);
  fs.writeFileSync(handoffPromptPath, handoffPrompt);

  await terminateSessionWorker(session);
  parkBackend(session.id, sourceBackend);
  updateSessionBackend(session.id, sourceBackend, {
    state: 'parked',
    lastHandoffAt: Date.now(),
  });

  setSessionActiveBackend(session.id, targetBackend);
  updateSessionStatus(session.id, 'starting', null);
  updateSessionRuntime(session.id, {
    transportState: 'disconnected',
    workerStatus: 'starting',
  });

  const targetSession = getSession(session.id) || {
    ...session,
    activeBackend: targetBackend,
  };
  startBridge(targetSession, discordClient);

  try {
    if (targetBackend === 'claude') {
      await startClaudeForSwitch(targetSession, handoffPromptPath);
    } else {
      await startCodexForSwitch(targetSession, handoffPrompt);
    }
  } catch (err: any) {
    await rollbackFailedSwitch(session, sourceBackend, targetBackend, discordClient);
    throw new Error(err.message);
  }

  const now = Date.now();
  markBackendActive(session.id, targetBackend, now);
  updateSessionBackend(session.id, targetBackend, {
    lastHandoffAt: now,
  });
  updateSessionBackend(session.id, sourceBackend, {
    state: 'parked',
    lastHandoffAt: now,
  });

  const latest = getSession(session.id) || targetSession;
  return {
    session: latest,
    previousBackend: sourceBackend,
    activeBackend: targetBackend,
    handoffPromptLength: handoffPrompt.length,
    inactiveBackendParked: true,
  };
}

export async function reconcileOnStartup(discordClient: Client): Promise<ReconciliationReport> {
  const runtimeBuildId = process.env.CONDUCTOR_RUNTIME_BUILD_ID || getRuntimeBuildId();
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
    if (worker && hasCompatibleWorkerRuntime(runtimeBuildId, worker)) {
      if (session.status === 'active' || session.status === 'starting' || session.status === 'idle') {
        report.liveAndHealthy.push(session.name);
      } else {
        report.reattached.push(session.name);
      }
      await reattachSession(session, discordClient);
      continue;
    }

    if (worker && !hasCompatibleWorkerRuntime(runtimeBuildId, worker)) {
      clearWorkerRuntime(session.id);
      updateSessionRuntime(session.id, {
        workerId: null,
        terminalHandle: null,
        transportState: 'disconnected',
        workerStatus: 'stopped',
        pid: null,
      });
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

async function restartClaudeSession(
  session: Session,
  discordClient: Client,
  reason: 'resume' | 'directory-access-update'
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
    markBackendActive(session.id, 'claude');
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

  await terminateSessionWorker(latestForCli);

  const checkpoint = readCheckpoint(session);
  const discordMessages = await fetchRecentSessionMessages(session, discordClient);
  const mergedMessages = mergeCheckpointMessages(checkpoint?.recentMessages ?? [], discordMessages);
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
    throw new Error(promptResume.error || cliResume.error || 'Failed to resume Claude backend');
  }

  markBackendActive(session.id, 'claude');
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

async function restartCodexSession(
  session: Session,
  discordClient: Client,
  reason: 'resume' | 'directory-access-update'
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

  const start = await spawnSessionWorker(session, { mode: 'resume' });
  if (!start.ready) {
    markInterrupted(session.id);
    throw new Error(start.error || 'Failed to restart Codex backend');
  }

  markBackendActive(session.id, 'codex');
  if (reason === 'resume') {
    await postResumeNotice(discordClient, session, 'worker', reason);
  }
  return {
    session: getSession(session.id) || session,
    checkpointUsed: false,
    messagesInjected: 0,
    resumePromptLength: 0,
    resumeStrategy: 'worker',
  };
}

async function startClaudeForSwitch(session: Session, handoffPromptPath: string): Promise<void> {
  const claudeSummary = getSessionBackend(session.id, 'claude');
  const resumable = getBackendAdapter('claude').isResumable(claudeSummary);

  if (!resumable) {
    const created = await spawnSessionWorker(session, {
      mode: 'new',
      resumePromptPath: handoffPromptPath,
    });
    if (!created.ready) {
      throw new Error(created.error || 'Failed to start Claude backend');
    }

    updateSessionBackend(session.id, 'claude', {
      nativeSessionName: claudeSummary?.nativeSessionName || session.claudeSessionName || session.name,
      nativeResumeRef: claudeSummary?.nativeResumeRef || session.claudeResumeRef || session.claudeSessionName || session.name,
      state: 'active',
    });
    return;
  }

  const resumed = await spawnSessionWorker(session, {
    mode: 'resume',
    resumePromptPath: handoffPromptPath,
  });
  if (resumed.ready) {
    return;
  }

  await terminateSessionWorker(session);
  const fallback = await spawnSessionWorker(session, {
    mode: 'resume-prompt',
    resumePromptPath: handoffPromptPath,
  });
  if (!fallback.ready) {
    throw new Error(fallback.error || resumed.error || 'Failed to switch to Claude backend');
  }
}

async function startCodexForSwitch(session: Session, handoffPrompt: string): Promise<void> {
  updateSessionBackend(session.id, 'codex', {
    nativeSessionName: getSessionBackend(session.id, 'codex')?.nativeSessionName || session.name,
    state: 'active',
  });

  const start = await spawnSessionWorker(session, { mode: 'new' });
  if (!start.ready) {
    throw new Error(start.error || 'Failed to start Codex backend');
  }

  const handoffResult = await sendInputToWorker(getSession(session.id) || session, handoffPrompt);
  if (!handoffResult.ok) {
    await terminateSessionWorker(session);
    throw new Error(`Codex handoff turn failed: ${handoffResult.error || 'unknown error'}`);
  }
}

async function rollbackFailedSwitch(
  session: Session,
  sourceBackend: AgentBackend,
  targetBackend: AgentBackend,
  discordClient: Client
): Promise<void> {
  logger.warn(`Switch from ${sourceBackend} to ${targetBackend} failed for ${session.name}; attempting rollback`);

  setSessionActiveBackend(session.id, sourceBackend);
  const targetSummary = getSessionBackend(session.id, targetBackend);
  updateSessionBackend(session.id, targetBackend, {
    state: targetSummary && (
      targetSummary.resumable ||
      targetSummary.lastActiveAt !== null ||
      (targetBackend === 'claude' && (!!targetSummary.nativeSessionName || !!targetSummary.nativeResumeRef))
    ) ? 'parked' : 'never_started',
  });
  updateSessionStatus(session.id, 'starting', null);
  updateSessionRuntime(session.id, {
    transportState: 'disconnected',
    workerStatus: 'starting',
  });

  const rollbackSession = getSession(session.id) || {
    ...session,
    activeBackend: sourceBackend,
  };
  startBridge(rollbackSession, discordClient);

  const restored = await spawnSessionWorker(rollbackSession, {
    mode: sourceBackend === 'claude' ? 'resume' : 'resume',
  });
  if (!restored.ready) {
    markInterrupted(session.id);
    throw new Error(restored.error || `Rollback to ${sourceBackend} failed`);
  }

  markBackendActive(session.id, sourceBackend);
}

async function postResumeNotice(
  discordClient: Client,
  session: Session,
  strategy: 'cli' | 'checkpoint' | 'worker',
  reason: 'resume' | 'directory-access-update'
): Promise<void> {
  try {
    const channel = await discordClient.channels.fetch(session.discordChannelId) as TextChannel | null;
    if (!channel) return;
    const latest = getSession(session.id) || session;
    const action = reason === 'directory-access-update'
      ? 'is restarting to apply updated directory access'
      : 'is resuming';
    await channel.send(
      `↺ Session **${session.name}** ${action} on **${getBackendDisplayName(latest.activeBackend)}** ` +
      `(resume #${latest.resumeCount}) via **${strategy}**...`
    );
  } catch (err: any) {
    logger.error(`Failed to post resume notice for ${session.name}: ${err.message}`);
  }
}

async function postReconciliationReport(report: ReconciliationReport, discordClient: Client): Promise<void> {
  try {
    const guild = discordClient.guilds.cache.get(process.env.DISCORD_GUILD_ID!);
    const orchestratorName = process.env.ORCHESTRATOR_CHANNEL_NAME || 'orchestrator';
    const channel = guild?.channels.cache.find(
      entry => entry.name === orchestratorName && entry.isTextBased()
    ) as TextChannel | undefined;
    if (!channel) return;

    const lines: string[] = ['Startup reconciliation complete.'];
    if (report.reattached.length > 0) {
      lines.push(`Reattached live sessions: ${report.reattached.join(', ')}`);
    }
    if (report.interrupted.length > 0) {
      lines.push(`Interrupted (use \`${formatCommand('resume <name>')}\` to recover): ${report.interrupted.join(', ')}`);
    }
    if (report.cleaned.length > 0) {
      lines.push(`Cleaned orphaned records: ${report.cleaned.join(', ')}`);
    }
    await channel.send(lines.join('\n'));
  } catch (err: any) {
    logger.error(`Failed to post reconciliation report: ${err.message}`);
  }
}

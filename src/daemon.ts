import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ChannelType, Client, TextChannel } from 'discord.js';
import { nanoid } from 'nanoid';
import { buildArchivedChannelName, findArchiveCategory } from './channel-archive.js';
import {
  formatInactiveBackendSummary,
  getBackendDisplayName,
  getDefaultAgentBackend,
  getSessionBackendSummary,
  isAgentBackend,
  isBackendEnabled,
} from './agent-backends.js';
import { getRuntimeBuildId } from './runtime-build.js';
import { getReadyHeartbeatTransition } from './worker-heartbeat.js';
import { getWorkerBuildCompatibilityIssue } from './worker-runtime-compat.js';
import {
  formatRuntimeBuildIdForLog,
  isDiscordMissingPermissionsError,
  requestWorkerTerminate,
  terminateWorkerProcess,
} from './worker-control.js';
import {
  disconnectChannel,
  handleChannelReaction,
  handleChannelReply,
  handleWorkerNotice,
  nextChannelEvent,
  registerChannel,
  registerWorker,
  startBridge,
  stopBridge,
  updateWorkerHeartbeat,
} from './bridge.js';
import { logger } from './logger.js';
import { resumeSession, restartSession, switchSessionBackend } from './resume.js';
import {
  createSession,
  deleteSession,
  getActiveSessions,
  getAllSessions,
  getSession,
  getSessionBackend,
  getSessionByName,
  getSessionInternalAuth,
  markBackendActive,
  markInterrupted,
  updateSessionActivity,
  updateSessionAdditionalDirs,
  updateSessionBackend,
  updateSessionRuntime,
  updateSessionStatus,
} from './sessions.js';
import { managedPathsEqual, normalizeManagedPath, resolveUserPath } from './state.js';
import type {
  AddDirRequest,
  AddDirResult,
  AgentBackend,
  ChannelReactionPayload,
  ChannelReplyPayload,
  DaemonResponse,
  Session,
  SpawnRequest,
  SwitchBackendRequest,
  SwitchBackendResult,
  WorkerHeartbeat,
  WorkerRegistration,
} from './types.js';
import { clearWorkerRuntime, endSessionTurn, getWorkerRuntime, isSessionTurnLocked } from './runtime-state.js';
import { spawnSessionWorker, terminateSessionWorker } from './worker-manager.js';
import { formatCommand } from './command-prefix.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;
const WORKER_STALE_MS = 20_000;
const runtimeBuildId = process.env.CONDUCTOR_RUNTIME_BUILD_ID || getRuntimeBuildId();

let healthMonitorTimer: ReturnType<typeof setInterval> | null = null;

interface DaemonDeps {
  discordClient: Client;
  getConductorCategory: () => string | undefined;
}

export function createDaemon(deps: DaemonDeps): express.Express {
  const app = express();
  app.use(express.json());

  const { discordClient, getConductorCategory } = deps;

  app.post('/sessions/spawn', async (req, res) => {
    let createdChannel: TextChannel | null = null;
    let createdSession: Session | null = null;
    let bridgeStarted = false;
    try {
      const body = req.body as SpawnRequest;
      if (!body.name || !NAME_RE.test(body.name)) {
        res.json({ ok: false, error: 'Name must be 2-32 chars, lowercase alphanumeric and hyphens only' } as DaemonResponse);
        return;
      }

      if (getSessionByName(body.name)) {
        res.json({ ok: false, error: `Session "${body.name}" already exists` } as DaemonResponse);
        return;
      }

      const maxSessions = parseInt(process.env.MAX_SESSIONS || '10', 10);
      if (getActiveSessions().length >= maxSessions) {
        res.json({ ok: false, error: `Maximum sessions reached (${maxSessions})` } as DaemonResponse);
        return;
      }

      const requestedBackend = body.agentBackend || getDefaultAgentBackend();
      if (!isBackendEnabled(requestedBackend)) {
        res.json({ ok: false, error: `Backend "${requestedBackend}" is not enabled` } as DaemonResponse);
        return;
      }

      const defaultWorkDir = resolveUserPath(process.env.DEFAULT_WORK_DIR || path.join(os.homedir(), 'projects'));
      const projectDir = body.projectDir
        ? resolveUserPath(body.projectDir)
        : path.join(defaultWorkDir, body.name);

      if (!fs.existsSync(projectDir)) {
        fs.mkdirSync(projectDir, { recursive: true });
      }

      const guild = discordClient.guilds.cache.get(process.env.DISCORD_GUILD_ID!);
      if (!guild) {
        res.json({ ok: false, error: 'Discord guild not found' } as DaemonResponse);
        return;
      }

      createdChannel = await guild.channels.create({
        name: body.name,
        type: ChannelType.GuildText,
        parent: getConductorCategory(),
        topic: `CC Conductor session: ${body.name} | Backend: ${requestedBackend} | Dir: ${projectDir}`,
      });

      const terminalBackend = requestedBackend === 'claude'
        ? (process.env.TERMINAL_BACKEND === 'tmux' ? 'tmux' : 'pty')
        : 'none';
      const claudeSessionName = body.name;
      const session: Session = {
        id: nanoid(8),
        name: body.name,
        discordChannelId: createdChannel.id,
        discordChannelName: createdChannel.name,
        tmuxSession: terminalBackend === 'tmux' ? `conductor-${body.name}` : null,
        projectDir,
        additionalDirs: [],
        pid: null,
        status: 'starting',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        lastCheckpointAt: null,
        checkpointPath: null,
        resumeCount: 0,
        interruptedAt: null,
        indicatorMode: null,
        workerId: null,
        terminalBackend,
        terminalHandle: requestedBackend === 'claude' && terminalBackend === 'tmux' ? `conductor-${body.name}` : null,
        transportKind: requestedBackend === 'codex'
          ? 'worker_http'
          : (process.env.STRUCTURED_TRANSPORT === 'off' ? 'pty_fallback' : 'channel'),
        transportState: 'disconnected',
        activeBackend: requestedBackend,
        backendStates: [],
        claudeSessionName,
        claudeResumeRef: claudeSessionName,
        workerStatus: 'starting',
      };

      createdSession = session;
      createSession(session);
      startBridge(session, discordClient);
      bridgeStarted = true;
      const start = await spawnSessionWorker(session, { mode: 'new' });
      if (!start.ready) {
        stopBridge(session.id);
        bridgeStarted = false;
        await terminateSessionWorker(session);
        deleteSession(session.id);
        createdSession = null;
        await deleteDiscordChannel(createdChannel);
        createdChannel = null;
        res.json({ ok: false, error: start.error || 'Worker failed to start' } as DaemonResponse);
        return;
      }

      const updated = getSession(session.id)!;
      markBackendActive(session.id, requestedBackend);
      updateSessionStatus(session.id, 'active', updated.pid);

      res.json({ ok: true, data: getSession(session.id)! } as DaemonResponse<Session>);
    } catch (err: any) {
      if (bridgeStarted && createdSession) {
        stopBridge(createdSession.id);
      }
      if (createdSession) {
        await terminateSessionWorker(createdSession);
        deleteSession(createdSession.id);
      }
      if (createdChannel) {
        await deleteDiscordChannel(createdChannel);
      }
      logger.error(`Spawn failed: ${err.message}`);
      res.json({ ok: false, error: err.message } as DaemonResponse);
    }
  });

  app.delete('/sessions/:id', async (req, res) => {
    try {
      const session = getSession(req.params.id);
      if (!session) {
        res.json({ ok: false, error: 'Session not found' } as DaemonResponse);
        return;
      }

      stopBridge(session.id);
      await terminateSessionWorker(session);
      await handleSessionChannelDeletion(session, discordClient);
      deleteSession(session.id);
      res.json({ ok: true } as DaemonResponse);
    } catch (err: any) {
      logger.error(`Delete failed: ${err.message}`);
      res.json({ ok: false, error: err.message } as DaemonResponse);
    }
  });

  app.get('/sessions', (_req, res) => {
    try {
      res.json({ ok: true, data: getAllSessions() } as DaemonResponse<Session[]>);
    } catch (err: any) {
      res.json({ ok: false, error: err.message } as DaemonResponse);
    }
  });

  app.get('/sessions/:id', (req, res) => {
    try {
      const session = getSession(req.params.id);
      if (!session) {
        res.json({ ok: false, error: 'Session not found' } as DaemonResponse);
        return;
      }
      res.json({ ok: true, data: session } as DaemonResponse<Session>);
    } catch (err: any) {
      res.json({ ok: false, error: err.message } as DaemonResponse);
    }
  });

  app.post('/sessions/:id/ping', (req, res) => {
    try {
      const session = getSession(req.params.id);
      if (!session) {
        res.json({ ok: false, error: 'Session not found' } as DaemonResponse);
        return;
      }
      updateSessionActivity(session.id);
      res.json({ ok: true } as DaemonResponse);
    } catch (err: any) {
      res.json({ ok: false, error: err.message } as DaemonResponse);
    }
  });

  app.post('/sessions/:id/resume', async (req, res) => {
    try {
      const session = getSession(req.params.id);
      if (!session) {
        res.json({ ok: false, error: 'Session not found' } as DaemonResponse);
        return;
      }
      if (session.status !== 'interrupted') {
        res.json({ ok: false, error: `Session is ${session.status}, not interrupted` } as DaemonResponse);
        return;
      }
      const result = await resumeSession(session, discordClient);
      res.json({ ok: true, data: result } as DaemonResponse);
    } catch (err: any) {
      logger.error(`Resume failed: ${err.message}`);
      res.json({ ok: false, error: err.message } as DaemonResponse);
    }
  });

  app.post('/sessions/:id/backend', async (req, res) => {
    try {
      const session = getSession(req.params.id);
      if (!session) {
        res.json({ ok: false, error: 'Session not found' } as DaemonResponse);
        return;
      }

      if (isSessionTurnLocked(session.id)) {
        res.json({ ok: false, error: 'A turn is still in progress. Retry after the current turn finishes.' } as DaemonResponse);
        return;
      }

      const body = req.body as SwitchBackendRequest;
      if (!body.backend || !isAgentBackend(body.backend)) {
        res.json({ ok: false, error: 'backend must be claude or codex' } as DaemonResponse);
        return;
      }

      if (!isBackendEnabled(body.backend)) {
        res.json({ ok: false, error: `Backend "${body.backend}" is not enabled` } as DaemonResponse);
        return;
      }

      const result = await switchSessionBackend(session, body.backend, discordClient);
      res.json({ ok: true, data: result } as DaemonResponse<SwitchBackendResult>);
    } catch (err: any) {
      logger.error(`Backend switch failed: ${err.message}`);
      res.json({ ok: false, error: err.message } as DaemonResponse);
    }
  });

  app.post('/sessions/:id/add-dir', async (req, res) => {
    try {
      const session = getSession(req.params.id);
      if (!session) {
        res.json({ ok: false, error: 'Session not found' } as DaemonResponse);
        return;
      }

      if (session.status === 'dead') {
        res.json({ ok: false, error: 'Session is dead. Start a new session instead.' } as DaemonResponse);
        return;
      }

      if (session.status === 'starting') {
        res.json({ ok: false, error: 'Session is still starting. Wait until it is live, then retry.' } as DaemonResponse);
        return;
      }

      const body = req.body as AddDirRequest;
      if (!body.path?.trim()) {
        res.json({ ok: false, error: 'path is required' } as DaemonResponse);
        return;
      }

      const normalizedPath = normalizeManagedPath(body.path);
      let stats: fs.Stats;
      try {
        stats = fs.statSync(normalizedPath);
      } catch {
        res.json({ ok: false, error: `Directory does not exist: ${normalizedPath}` } as DaemonResponse);
        return;
      }

      if (!stats.isDirectory()) {
        res.json({ ok: false, error: `Path is not a directory: ${normalizedPath}` } as DaemonResponse);
        return;
      }

      if (managedPathsEqual(session.projectDir, normalizedPath)) {
        res.json({ ok: false, error: `Path is already the session root: ${normalizedPath}` } as DaemonResponse);
        return;
      }

      if (session.additionalDirs.some(existing => managedPathsEqual(existing, normalizedPath))) {
        res.json({ ok: false, error: `Path is already allowed for this session: ${normalizedPath}` } as DaemonResponse);
        return;
      }

      updateSessionAdditionalDirs(session.id, [...session.additionalDirs, normalizedPath]);
      const latest = getSession(session.id) || session;
      const restart = await restartSession(latest, discordClient, 'directory-access-update');

      res.json({
        ok: true,
        data: {
          session: restart.session,
          addedDir: normalizedPath,
          resumeStrategy: restart.resumeStrategy,
        } satisfies AddDirResult,
      } as DaemonResponse<AddDirResult>);
    } catch (err: any) {
      logger.error(`Add-dir failed: ${err.message}`);
      res.json({ ok: false, error: err.message } as DaemonResponse);
    }
  });

  app.post('/internal/sessions/:id/worker/register', async (req, res) => {
    const session = getSession(req.params.id);
    if (!session || !authorizeInternal(req, session.id, 'worker')) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }

    const payload = req.body as WorkerRegistration;
    const compatibilityIssue = getWorkerBuildCompatibilityIssue(runtimeBuildId, payload);
    if (compatibilityIssue) {
      void interruptStaleWorkerSession(session.id, payload, compatibilityIssue, discordClient);
      res.status(409).json({ ok: false, error: 'Worker is running stale CC Conductor code' });
      return;
    }

    registerWorker(session.id, payload);
    updateSessionRuntime(session.id, {
      workerId: payload.workerId,
      terminalBackend: payload.terminalBackend,
      terminalHandle: payload.terminalHandle,
      workerStatus: payload.workerStatus,
      pid: payload.claudePid,
    });
    res.json({ ok: true });
  });

  app.post('/internal/sessions/:id/worker/heartbeat', async (req, res) => {
    const session = getSession(req.params.id);
    if (!session || !authorizeInternal(req, session.id, 'worker')) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }

    const payload = req.body as WorkerHeartbeat;
    const compatibilityIssue = getWorkerBuildCompatibilityIssue(runtimeBuildId, payload);
    if (compatibilityIssue) {
      void interruptStaleWorkerSession(session.id, payload, compatibilityIssue, discordClient);
      res.status(409).json({ ok: false, error: 'Worker is running stale CC Conductor code' });
      return;
    }

    updateWorkerHeartbeat(session.id, payload);
    updateSessionRuntime(session.id, {
      workerId: payload.workerId,
      terminalBackend: payload.terminalBackend,
      terminalHandle: payload.terminalHandle,
      workerStatus: payload.workerStatus,
      pid: payload.claudePid,
    });

    if (payload.workerStatus === 'ready') {
      const latest = getSession(session.id);
      const transition = latest ? getReadyHeartbeatTransition(latest, payload) : null;
      if (latest && transition) {
        if (transition.shouldMarkBackendActive) {
          markBackendActive(session.id, latest.activeBackend);
        }
        if (Object.keys(transition.runtimePatch).length > 0) {
          updateSessionRuntime(session.id, transition.runtimePatch);
        }
        updateSessionStatus(session.id, 'active', payload.claudePid);
        if (transition.notice === 'ready') {
          await postSessionReadyNotice(session.id, discordClient);
        } else {
          await postReconnectedNotice(session.id, discordClient);
        }
      }
    } else if (payload.workerStatus === 'exited') {
      const latest = getSession(session.id);
      if (latest && latest.status !== 'dead' && latest.status !== 'interrupted') {
        endSessionTurn(session.id);
        markInterrupted(session.id);
        await postInterruptedNotice(session.id, discordClient);
      }
    }

    res.json({ ok: true });
  });

  app.post('/internal/sessions/:id/worker/notice', async (req, res) => {
    const session = getSession(req.params.id);
    if (!session || !authorizeInternal(req, session.id, 'worker')) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }

    const payload = req.body as { message?: string };
    if (!payload.message) {
      res.status(400).json({ ok: false, error: 'message is required' });
      return;
    }

    await handleWorkerNotice(session.id, payload.message, discordClient);
    res.json({ ok: true });
  });

  app.post('/internal/sessions/:id/worker/backend-state', async (req, res) => {
    const session = getSession(req.params.id);
    if (!session || !authorizeInternal(req, session.id, 'worker')) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }

    const payload = req.body as {
      backend?: AgentBackend;
      nativeSessionName?: string | null;
      nativeResumeRef?: string | null;
      state?: 'never_started' | 'active' | 'parked';
      lastActiveAt?: number | null;
      lastHandoffAt?: number | null;
    };
    if (!payload.backend || !isAgentBackend(payload.backend)) {
      res.status(400).json({ ok: false, error: 'backend is required' });
      return;
    }

    updateSessionBackend(session.id, payload.backend, {
      nativeSessionName: payload.nativeSessionName,
      nativeResumeRef: payload.nativeResumeRef,
      state: payload.state,
      lastActiveAt: payload.lastActiveAt,
      lastHandoffAt: payload.lastHandoffAt,
    });
    res.json({ ok: true });
  });

  app.post('/internal/sessions/:id/channel/register', async (req, res) => {
    const session = getSession(req.params.id);
    if (!session || !authorizeInternal(req, session.id, 'channel')) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }

    registerChannel(session.id);
    updateSessionRuntime(session.id, {
      transportKind: 'channel',
      transportState: 'connected',
    });
    res.json({ ok: true });
  });

  app.post('/internal/sessions/:id/channel/disconnect', async (req, res) => {
    const session = getSession(req.params.id);
    if (!session || !authorizeInternal(req, session.id, 'channel')) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }

    disconnectChannel(session.id);
    updateSessionRuntime(session.id, {
      transportState: 'disconnected',
    });
    res.json({ ok: true });
  });

  app.get('/internal/sessions/:id/channel/events', async (req, res) => {
    const session = getSession(req.params.id);
    if (!session || !authorizeInternal(req, session.id, 'channel')) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }

    const timeoutMs = Math.min(parseInt(String(req.query.timeoutMs || '25000'), 10), 30_000);
    const event = await nextChannelEvent(session.id, timeoutMs);
    if (!event) {
      res.status(204).end();
      return;
    }
    res.json(event);
  });

  app.post('/internal/sessions/:id/channel/reply', async (req, res) => {
    const session = getSession(req.params.id);
    if (!session || !authorizeInternal(req, session.id, 'channel')) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }

    await handleChannelReply(session.id, req.body as ChannelReplyPayload, discordClient);
    res.json({ ok: true });
  });

  app.post('/internal/sessions/:id/channel/react', async (req, res) => {
    const session = getSession(req.params.id);
    if (!session || !authorizeInternal(req, session.id, 'channel')) {
      res.status(401).json({ ok: false, error: 'Unauthorized' });
      return;
    }

    await handleChannelReaction(session.id, req.body as ChannelReactionPayload, discordClient);
    res.json({ ok: true });
  });

  return app;
}

export function startHealthMonitor(discordClient: Client): void {
  healthMonitorTimer = setInterval(async () => {
    const sessions = getAllSessions();
    const idleTimeoutMins = parseInt(process.env.SESSION_IDLE_TIMEOUT_MINS || '120', 10);

    for (const session of sessions) {
      if (session.status !== 'active' && session.status !== 'starting' && session.status !== 'idle') {
        continue;
      }

      const worker = getWorkerRuntime(session.id);
      const compatibilityIssue = worker ? getWorkerBuildCompatibilityIssue(runtimeBuildId, worker) : null;
      if (!worker || compatibilityIssue || Date.now() - worker.lastHeartbeatAt > WORKER_STALE_MS) {
        if (worker && compatibilityIssue) {
          logger.warn(
            `Session ${session.name}: worker runtime build mismatch; daemon=${formatRuntimeBuildIdForLog(runtimeBuildId)} worker=${formatRuntimeBuildIdForLog(worker.runtimeBuildId)}`
          );
          clearWorkerRuntime(session.id);
          updateSessionRuntime(session.id, {
            workerId: null,
            terminalHandle: null,
            transportState: 'disconnected',
            workerStatus: 'stopped',
            pid: null,
          });
        } else {
          logger.warn(`Session ${session.name}: worker stale or missing`);
        }
        endSessionTurn(session.id);
        markInterrupted(session.id);
        await postInterruptedNotice(session.id, discordClient);
        continue;
      }

      if (idleTimeoutMins > 0) {
        const idleMs = Date.now() - session.lastActiveAt;
        const idleMins = idleMs / 60_000;
        if (idleMins >= idleTimeoutMins) {
          try {
            const channel = await discordClient.channels.fetch(session.discordChannelId) as TextChannel | null;
            if (channel) {
              await channel.send(`⚠ This session has been idle for ${Math.round(idleMins)} minutes and will be closed.`);
            }
          } catch {
            // best effort
          }

          await terminateSessionWorker(session);
          endSessionTurn(session.id);
          updateSessionStatus(session.id, 'dead', null);
          updateSessionRuntime(session.id, {
            transportState: 'disconnected',
            workerStatus: 'stopped',
          });
        }
      }
    }
  }, 60_000);
}

export function stopHealthMonitor(): void {
  if (healthMonitorTimer) {
    clearInterval(healthMonitorTimer);
    healthMonitorTimer = null;
  }
}

async function handleSessionChannelDeletion(session: Session, discordClient: Client): Promise<void> {
  const archiveOnKill = process.env.ARCHIVE_ON_KILL !== 'false';
  try {
    const guild = discordClient.guilds.cache.get(process.env.DISCORD_GUILD_ID!);
    const channel = guild
      ? await guild.channels.fetch(session.discordChannelId).catch(() => null)
      : null;
    if (!channel) return;

    if (archiveOnKill) {
      const textChannel = channel as TextChannel;
      await textChannel.setName(buildArchivedChannelName(session.name));
      await textChannel.send(`⚠ Session **${session.name}** has been killed and archived.`);

      const guildChannels = guild ? await guild.channels.fetch() : null;
      let archiveCategory = guildChannels ? findArchiveCategory(guildChannels.values()) : null;
      if (!archiveCategory && guild) {
        archiveCategory = await guild.channels.create({
          name: 'Archive',
          type: ChannelType.GuildCategory,
        });
      }
      if (archiveCategory) {
        await textChannel.setParent(archiveCategory.id, { lockPermissions: false });
      }
      return;
    }

    await channel.delete();
  } catch (err: any) {
    if (isDiscordMissingPermissionsError(err)) {
      logger.warn(`Discord channel cleanup skipped for ${session.name}: missing permissions`);
      return;
    }
    logger.error(`Failed to handle Discord channel for ${session.name}: ${err.message}`);
  }
}

async function deleteDiscordChannel(channel: TextChannel): Promise<void> {
  try {
    await channel.delete();
  } catch {
    // best effort
  }
}

function authorizeInternal(
  req: express.Request,
  sessionId: string,
  kind: 'worker' | 'channel'
): boolean {
  const auth = getSessionInternalAuth(sessionId);
  if (!auth) return false;
  const expected = kind === 'worker' ? auth.workerToken : auth.channelToken;
  return req.headers.authorization === `Bearer ${expected}`;
}

async function postSessionReadyNotice(sessionId: string, discordClient: Client): Promise<void> {
  const session = getSession(sessionId);
  if (!session) return;
  try {
    const channel = await discordClient.channels.fetch(session.discordChannelId) as TextChannel | null;
    if (channel) {
      await channel.send(
        `✓ Session **${session.name}** is live on **${getBackendDisplayName(session.activeBackend)}** in \`${session.projectDir}\`.` +
        ` ${formatInactiveBackendSummary(session)}.`
      );
    }
  } catch {
    // best effort
  }
}

async function postInterruptedNotice(sessionId: string, discordClient: Client): Promise<void> {
  const session = getSession(sessionId);
  if (!session) return;
  const orchestratorName = process.env.ORCHESTRATOR_CHANNEL_NAME || 'orchestrator';
  try {
    const channel = await discordClient.channels.fetch(session.discordChannelId) as TextChannel | null;
    if (channel) {
      await channel.send(
        `⚠ Session **${session.name}** on **${getBackendDisplayName(session.activeBackend)}** has been interrupted. ` +
        `Use \`${formatCommand(`resume ${session.name}`)}\` in #${orchestratorName} to recover.`
      );
    }
  } catch {
    // best effort
  }
}

async function postReconnectedNotice(sessionId: string, discordClient: Client): Promise<void> {
  const session = getSession(sessionId);
  if (!session) return;
  try {
    const channel = await discordClient.channels.fetch(session.discordChannelId) as TextChannel | null;
    if (channel) {
      await channel.send(
        `↺ Session **${session.name}** reconnected on **${getBackendDisplayName(session.activeBackend)}**.` +
        ` ${formatInactiveBackendSummary(session)}.`
      );
    }
  } catch {
    // best effort
  }
}

async function interruptStaleWorkerSession(
  sessionId: string,
  payload: Pick<WorkerRegistration, 'workerId' | 'runtimeBuildId' | 'port' | 'pid'>,
  compatibilityIssue: 'missing-runtime-build-id' | 'runtime-build-mismatch',
  discordClient: Client
): Promise<void> {
  const session = getSession(sessionId);
  if (!session) return;

  const shouldNotify = session.status !== 'interrupted' || session.workerId !== null;
  if (shouldNotify) {
    logger.warn(
      `Rejecting stale worker for ${session.name}: daemon=${formatRuntimeBuildIdForLog(runtimeBuildId)} worker=${formatRuntimeBuildIdForLog(payload.runtimeBuildId)} issue=${compatibilityIssue}`
    );
  }

  clearWorkerRuntime(session.id);
  endSessionTurn(session.id);
  markInterrupted(session.id);
  updateSessionRuntime(session.id, {
    workerId: null,
    terminalHandle: null,
    transportState: 'disconnected',
    workerStatus: 'stopped',
    pid: null,
  });

  if (shouldNotify) {
    await postStaleWorkerInterruptedNotice(session.id, discordClient);
  }

  await terminateWorkerAtPort(session.id, payload.port, payload.pid);
}

async function terminateWorkerAtPort(sessionId: string, port: number, pid: number): Promise<void> {
  const auth = getSessionInternalAuth(sessionId);
  let terminated = false;

  if (auth?.workerToken && Number.isFinite(port) && port > 0) {
    const result = await requestWorkerTerminate(port, auth.workerToken);
    terminated = result.ok;
  }

  if (!terminated) {
    terminateWorkerProcess(pid);
  }
}

async function postStaleWorkerInterruptedNotice(sessionId: string, discordClient: Client): Promise<void> {
  const session = getSession(sessionId);
  if (!session) return;
  const orchestratorName = process.env.ORCHESTRATOR_CHANNEL_NAME || 'orchestrator';
  try {
    const channel = await discordClient.channels.fetch(session.discordChannelId) as TextChannel | null;
    if (channel) {
      await channel.send(
        `⚠ Session **${session.name}** was interrupted because its worker is running stale CC Conductor code. ` +
        `Use \`${formatCommand(`resume ${session.name}`)}\` in #${orchestratorName} to start a fresh worker.`
      );
    }
  } catch {
    // best effort
  }
}

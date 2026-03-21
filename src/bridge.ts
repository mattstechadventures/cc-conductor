import { Client, TextChannel } from 'discord.js';
import {
  beginSessionTurn,
  applyWorkerHeartbeat,
  clearRuntimeState,
  endSessionTurn,
  ensureRuntimeState,
  isChannelConnected,
  markChannelConnected,
  markChannelDisconnected,
  queueChannelEvent,
  registerWorkerRuntime,
  waitForNextChannelEvent,
} from './runtime-state.js';
import { sendInputToWorker } from './worker-manager.js';
import { getSession, updateSessionActivity, updateSessionRuntime } from './sessions.js';
import { logger } from './logger.js';
import type {
  ChannelReactionPayload,
  ChannelReplyPayload,
  IndicatorMode,
  Session,
  WorkerHeartbeat,
  WorkerRegistration,
} from './types.js';

const TYPING_INTERVAL_MS = 8_000;
const DEGRADED_NOTICE_COOLDOWN_MS = 60_000;

interface BridgeState {
  typingTimer: ReturnType<typeof setInterval> | null;
  degradedNoticeAt: number | null;
}

const bridges = new Map<string, BridgeState>();
let globalIndicatorMode: IndicatorMode = 'typing';

export function getGlobalIndicatorMode(): IndicatorMode {
  return globalIndicatorMode;
}

export function setGlobalIndicatorMode(mode: IndicatorMode): void {
  globalIndicatorMode = mode;
}

function getBridgeState(sessionId: string): BridgeState {
  let state = bridges.get(sessionId);
  if (!state) {
    state = {
      typingTimer: null,
      degradedNoticeAt: null,
    };
    bridges.set(sessionId, state);
  }
  return state;
}

function getIndicatorMode(session: Session): IndicatorMode {
  const fresh = getSession(session.id);
  if (fresh?.indicatorMode) return fresh.indicatorMode;
  const env = process.env.INDICATOR_MODE as IndicatorMode | undefined;
  if (globalIndicatorMode) return globalIndicatorMode;
  if (env === 'off' || env === 'typing') return env;
  return 'typing';
}

export function startBridge(session: Session, _discordClient: Client): void {
  ensureRuntimeState(session.id);
  getBridgeState(session.id);
}

export function stopBridge(sessionId: string): void {
  const state = bridges.get(sessionId);
  if (state?.typingTimer) {
    clearInterval(state.typingTimer);
  }
  bridges.delete(sessionId);
  clearRuntimeState(sessionId);
}

export function stopAllBridges(): void {
  for (const sessionId of [...bridges.keys()]) {
    stopBridge(sessionId);
  }
}

export async function sendToSession(
  session: Session,
  message: string,
  discordClient?: Client
): Promise<boolean> {
  ensureRuntimeState(session.id);
  updateSessionActivity(session.id);
  startTypingIndicator(session, discordClient || null);
  const turnStarted = beginSessionTurn(session.id, session.activeBackend);

  if (session.activeBackend === 'codex') {
    if (!turnStarted) {
      stopTypingIndicator(session.id);
      logger.warn(`Turn already in progress for ${session.name}`);
      return false;
    }

    const sentViaWorker = await sendInputToWorker(session, message);
    if (sentViaWorker) {
      updateSessionRuntime(session.id, {
        transportKind: 'worker_http',
        transportState: 'connected',
      });
      logger.info(`Sent worker-backed turn for ${session.name} via Codex`);
      return true;
    }

    endSessionTurn(session.id);
    stopTypingIndicator(session.id);
    updateSessionRuntime(session.id, {
      transportKind: 'worker_http',
      transportState: 'disconnected',
    });
    logger.warn(`No worker transport available for ${session.name}`);
    return false;
  }

  if (process.env.STRUCTURED_TRANSPORT !== 'off' && isChannelConnected(session.id)) {
    queueChannelEvent(session.id, {
      content: message,
      meta: {
        chat_id: session.discordChannelId,
        source: 'discord',
        session_id: session.id,
      },
    });
    updateSessionRuntime(session.id, {
      transportKind: 'channel',
      transportState: 'connected',
    });
    logger.info(`Queued structured channel event for ${session.name}`);
    return true;
  }

  const sentViaWorker = await sendInputToWorker(session, message);
  if (sentViaWorker) {
    updateSessionRuntime(session.id, {
      transportKind: 'pty_fallback',
      transportState: 'degraded',
    });
    await maybePostDegradedNotice(session, discordClient || null);
    logger.warn(`Structured transport unavailable for ${session.name}; used PTY fallback`);
    return true;
  }

  if (turnStarted) {
    endSessionTurn(session.id);
  }
  stopTypingIndicator(session.id);
  logger.warn(`No transport available for ${session.name}`);
  return false;
}

export function registerWorker(sessionId: string, registration: WorkerRegistration): void {
  ensureRuntimeState(sessionId);
  registerWorkerRuntime(sessionId, registration);
}

export function updateWorkerHeartbeat(sessionId: string, heartbeat: WorkerHeartbeat): void {
  ensureRuntimeState(sessionId);
  applyWorkerHeartbeat(sessionId, heartbeat);
}

export function registerChannel(sessionId: string): void {
  ensureRuntimeState(sessionId);
  markChannelConnected(sessionId);
}

export function disconnectChannel(sessionId: string): void {
  ensureRuntimeState(sessionId);
  markChannelDisconnected(sessionId);
}

export async function nextChannelEvent(sessionId: string, timeoutMs: number) {
  return await waitForNextChannelEvent(sessionId, timeoutMs);
}

export async function handleChannelReply(
  sessionId: string,
  payload: ChannelReplyPayload,
  discordClient: Client
): Promise<void> {
  stopTypingIndicator(sessionId);
  endSessionTurn(sessionId);

  const session = getSession(sessionId);
  if (!session) return;

  updateSessionActivity(sessionId);
  updateSessionRuntime(sessionId, {
    transportKind: 'channel',
    transportState: 'connected',
  });

  const channel = await discordClient.channels.fetch(payload.chatId) as TextChannel | null;
  if (!channel) return;

  for (const chunk of splitMsg(payload.message, 1900)) {
    await channel.send(chunk);
  }
}

export async function handleChannelReaction(
  sessionId: string,
  payload: ChannelReactionPayload,
  discordClient: Client
): Promise<void> {
  const session = getSession(sessionId);
  if (!session) return;

  updateSessionActivity(sessionId);
  updateSessionRuntime(sessionId, {
    transportKind: 'channel',
    transportState: 'connected',
  });

  const channel = await discordClient.channels.fetch(payload.chatId) as TextChannel | null;
  if (!channel) return;

  const message = await channel.messages.fetch(payload.messageId);
  await message.react(payload.emoji);
}

export async function handleWorkerNotice(
  sessionId: string,
  message: string,
  discordClient: Client
): Promise<void> {
  stopTypingIndicator(sessionId);
  endSessionTurn(sessionId);

  const session = getSession(sessionId);
  if (!session) return;

  updateSessionActivity(sessionId);

  const channel = await discordClient.channels.fetch(session.discordChannelId) as TextChannel | null;
  if (!channel) return;

  for (const chunk of splitMsg(message, 1900)) {
    await channel.send(chunk);
  }
}

function startTypingIndicator(session: Session, discordClient: Client | null): void {
  const state = getBridgeState(session.id);
  stopTypingIndicator(session.id);
  if (!discordClient) return;
  if (getIndicatorMode(session) !== 'typing') return;

  const send = async () => {
    try {
      const channel = await discordClient.channels.fetch(session.discordChannelId) as TextChannel | null;
      if (channel) {
        await channel.sendTyping();
      }
    } catch {
      // best effort
    }
  };

  send().catch(() => {});
  state.typingTimer = setInterval(() => {
    send().catch(() => {});
  }, TYPING_INTERVAL_MS);
}

function stopTypingIndicator(sessionId: string): void {
  const state = bridges.get(sessionId);
  if (state?.typingTimer) {
    clearInterval(state.typingTimer);
    state.typingTimer = null;
  }
}

async function maybePostDegradedNotice(session: Session, discordClient: Client | null): Promise<void> {
  const state = getBridgeState(session.id);
  if (!discordClient) return;
  if (state.degradedNoticeAt && Date.now() - state.degradedNoticeAt < DEGRADED_NOTICE_COOLDOWN_MS) {
    return;
  }

  state.degradedNoticeAt = Date.now();
  try {
    const channel = await discordClient.channels.fetch(session.discordChannelId) as TextChannel | null;
    if (!channel) return;
    await channel.send('Structured transport is disconnected. Your message was sent through the PTY fallback, so replies may not mirror back to Discord until the channel reconnects.');
  } catch {
    // best effort
  }
}

function splitMsg(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    let i = rest.lastIndexOf('\n', max);
    if (i <= 0) i = max;
    chunks.push(rest.slice(0, i));
    rest = rest.slice(i).trimStart();
  }
  return chunks;
}

import type { ChannelQueuedEvent, WorkerHeartbeat, WorkerRegistration } from './types.js';

export interface WorkerRuntime extends WorkerRegistration {
  lastHeartbeatAt: number;
}

interface ChannelRuntime {
  connected: boolean;
  lastSeenAt: number;
}

interface SessionRuntimeState {
  worker: WorkerRuntime | null;
  channel: ChannelRuntime | null;
  queuedEvents: ChannelQueuedEvent[];
  waiters: Array<(event: ChannelQueuedEvent | null) => void>;
}

const runtimes = new Map<string, SessionRuntimeState>();

function getOrCreateRuntime(sessionId: string): SessionRuntimeState {
  let state = runtimes.get(sessionId);
  if (!state) {
    state = {
      worker: null,
      channel: null,
      queuedEvents: [],
      waiters: [],
    };
    runtimes.set(sessionId, state);
  }
  return state;
}

export function ensureRuntimeState(sessionId: string): void {
  getOrCreateRuntime(sessionId);
}

export function clearRuntimeState(sessionId: string): void {
  const state = runtimes.get(sessionId);
  if (!state) return;
  for (const waiter of state.waiters.splice(0)) {
    waiter(null);
  }
  runtimes.delete(sessionId);
}

export function registerWorkerRuntime(sessionId: string, registration: WorkerRegistration): void {
  const state = getOrCreateRuntime(sessionId);
  state.worker = {
    ...registration,
    lastHeartbeatAt: Date.now(),
  };
}

export function applyWorkerHeartbeat(sessionId: string, heartbeat: WorkerHeartbeat): void {
  const state = getOrCreateRuntime(sessionId);
  state.worker = {
    ...heartbeat,
    lastHeartbeatAt: Date.now(),
  };
}

export function getWorkerRuntime(sessionId: string): WorkerRuntime | null {
  return getOrCreateRuntime(sessionId).worker;
}

export function markChannelConnected(sessionId: string): void {
  const state = getOrCreateRuntime(sessionId);
  state.channel = {
    connected: true,
    lastSeenAt: Date.now(),
  };
}

export function markChannelDisconnected(sessionId: string): void {
  const state = getOrCreateRuntime(sessionId);
  state.channel = {
    connected: false,
    lastSeenAt: Date.now(),
  };
}

export function isChannelConnected(sessionId: string): boolean {
  const state = getOrCreateRuntime(sessionId);
  if (!state.channel?.connected) return false;
  return Date.now() - state.channel.lastSeenAt < 60_000;
}

export function queueChannelEvent(sessionId: string, event: ChannelQueuedEvent): void {
  const state = getOrCreateRuntime(sessionId);
  const waiter = state.waiters.shift();
  if (waiter) {
    waiter(event);
    return;
  }
  state.queuedEvents.push(event);
}

export async function waitForNextChannelEvent(
  sessionId: string,
  timeoutMs: number
): Promise<ChannelQueuedEvent | null> {
  const state = getOrCreateRuntime(sessionId);
  const event = state.queuedEvents.shift();
  if (event) return event;

  return await new Promise<ChannelQueuedEvent | null>((resolve) => {
    const timer = setTimeout(() => {
      state.waiters = state.waiters.filter(waiter => waiter !== resolver);
      resolve(null);
    }, timeoutMs);

    const resolver = (nextEvent: ChannelQueuedEvent | null) => {
      clearTimeout(timer);
      resolve(nextEvent);
    };

    state.waiters.push(resolver);
  });
}

export async function waitForWorkerStatus(
  sessionId: string,
  statuses: string[],
  timeoutMs: number
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const worker = getWorkerRuntime(sessionId);
    if (worker && statuses.includes(worker.workerStatus)) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return false;
}

export async function waitForWorkerRegistrations(
  sessionIds: string[],
  timeoutMs: number
): Promise<void> {
  const pending = new Set(sessionIds);
  if (pending.size === 0) return;

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs && pending.size > 0) {
    for (const sessionId of [...pending]) {
      if (getWorkerRuntime(sessionId)) {
        pending.delete(sessionId);
      }
    }
    if (pending.size === 0) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

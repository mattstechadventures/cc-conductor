import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWorkerHeartbeat,
  beginSessionTurn,
  clearRuntimeState,
  clearWorkerRuntime,
  endSessionTurn,
  ensureRuntimeState,
  getWorkerRuntime,
  isChannelConnected,
  isSessionTurnLocked,
  markChannelConnected,
  markChannelDisconnected,
  queueChannelEvent,
  registerWorkerRuntime,
  waitForNextChannelEvent,
} from './runtime-state.js';

function withMockedNow<T>(now: number, fn: () => T): T {
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = originalNow;
  }
}

test('session turn locks are per-session and releasable', () => {
  const sessionId = `turn-lock-${Date.now()}`;

  try {
    assert.equal(isSessionTurnLocked(sessionId), false);
    assert.equal(beginSessionTurn(sessionId, 'claude'), true);
    assert.equal(isSessionTurnLocked(sessionId), true);
    assert.equal(beginSessionTurn(sessionId, 'codex'), false);

    endSessionTurn(sessionId);
    assert.equal(isSessionTurnLocked(sessionId), false);
    assert.equal(beginSessionTurn(sessionId, 'codex'), true);
  } finally {
    clearRuntimeState(sessionId);
  }
});

test('worker runtime registrations capture heartbeats and can be cleared', () => {
  const sessionId = `worker-runtime-${Date.now()}`;

  try {
    withMockedNow(1_000_000, () => {
      ensureRuntimeState(sessionId);
      registerWorkerRuntime(sessionId, {
        workerId: 'worker-1',
        runtimeBuildId: 'build-1',
        port: 18888,
        pid: 1234,
        claudePid: 4321,
        activeBackend: 'codex',
        terminalHandle: 'terminal-1',
        terminalBackend: 'pty',
        workerStatus: 'starting',
      });
    });

    assert.deepEqual(getWorkerRuntime(sessionId), {
      workerId: 'worker-1',
      runtimeBuildId: 'build-1',
      port: 18888,
      pid: 1234,
      claudePid: 4321,
      activeBackend: 'codex',
      terminalHandle: 'terminal-1',
      terminalBackend: 'pty',
      workerStatus: 'starting',
      lastHeartbeatAt: 1_000_000,
    });

    withMockedNow(1_001_500, () => {
      applyWorkerHeartbeat(sessionId, {
        workerId: 'worker-1',
        runtimeBuildId: 'build-2',
        port: 19999,
        pid: 5678,
        claudePid: null,
        activeBackend: 'claude',
        terminalHandle: null,
        terminalBackend: 'tmux',
        workerStatus: 'ready',
      });
    });

    assert.deepEqual(getWorkerRuntime(sessionId), {
      workerId: 'worker-1',
      runtimeBuildId: 'build-2',
      port: 19999,
      pid: 5678,
      claudePid: null,
      activeBackend: 'claude',
      terminalHandle: null,
      terminalBackend: 'tmux',
      workerStatus: 'ready',
      lastHeartbeatAt: 1_001_500,
    });

    clearWorkerRuntime(sessionId);
    assert.equal(getWorkerRuntime(sessionId), null);
  } finally {
    clearRuntimeState(sessionId);
  }
});

test('channel connection state expires after the freshness window', () => {
  const sessionId = `channel-state-${Date.now()}`;

  try {
    withMockedNow(1_000_000, () => {
      markChannelConnected(sessionId);
    });

    assert.equal(
      withMockedNow(1_059_999, () => isChannelConnected(sessionId)),
      true
    );
    assert.equal(
      withMockedNow(1_060_001, () => isChannelConnected(sessionId)),
      false
    );

    withMockedNow(1_070_000, () => {
      markChannelDisconnected(sessionId);
    });
    assert.equal(withMockedNow(1_070_001, () => isChannelConnected(sessionId)), false);
  } finally {
    clearRuntimeState(sessionId);
  }
});

test('queued channel events are delivered to waiters and clear releases pending waiters', async () => {
  const sessionId = `channel-queue-${Date.now()}`;

  try {
    const delivered = waitForNextChannelEvent(sessionId, 50);
    queueChannelEvent(sessionId, {
      content: 'hello world',
      meta: {
        chat_id: 'discord-channel',
        source: 'discord',
        session_id: sessionId,
      },
    });

    await assert.doesNotReject(delivered);
    assert.deepEqual(await delivered, {
      content: 'hello world',
      meta: {
        chat_id: 'discord-channel',
        source: 'discord',
        session_id: sessionId,
      },
    });

    const pending = waitForNextChannelEvent(sessionId, 50);
    clearRuntimeState(sessionId);
    assert.equal(await pending, null);
  } finally {
    clearRuntimeState(sessionId);
  }
});

test('session turns reject contention until the lock is released', () => {
  const sessionId = `turn-contention-${Date.now()}`;

  try {
    assert.equal(beginSessionTurn(sessionId, 'claude'), true);
    assert.equal(beginSessionTurn(sessionId, 'codex'), false);
    endSessionTurn(sessionId);
    assert.equal(beginSessionTurn(sessionId, 'codex'), true);
  } finally {
    clearRuntimeState(sessionId);
  }
});

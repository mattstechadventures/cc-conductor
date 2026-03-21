import test from 'node:test';
import assert from 'node:assert/strict';
import { getReadyHeartbeatTransition } from './worker-heartbeat.js';

test('Codex ready heartbeat promotes starting sessions to connected worker_http transport', () => {
  const transition = getReadyHeartbeatTransition(
    { status: 'starting', activeBackend: 'codex' },
    { activeBackend: 'codex' }
  );

  assert.deepEqual(transition, {
    notice: 'ready',
    runtimePatch: {
      transportKind: 'worker_http',
      transportState: 'connected',
    },
    shouldMarkBackendActive: true,
  });
});

test('ready heartbeat on interrupted sessions produces a reconnected notice', () => {
  const transition = getReadyHeartbeatTransition(
    { status: 'interrupted', activeBackend: 'codex' },
    { activeBackend: 'codex' }
  );

  assert.equal(transition?.notice, 'reconnected');
  assert.equal(transition?.shouldMarkBackendActive, true);
});

test('Claude ready heartbeat does not force worker_http transport', () => {
  const transition = getReadyHeartbeatTransition(
    { status: 'starting', activeBackend: 'claude' },
    { activeBackend: 'claude' }
  );

  assert.deepEqual(transition?.runtimePatch, {});
});

test('ready heartbeat is ignored once the session is already active', () => {
  assert.equal(
    getReadyHeartbeatTransition(
      { status: 'active', activeBackend: 'codex' },
      { activeBackend: 'codex' }
    ),
    null
  );
});

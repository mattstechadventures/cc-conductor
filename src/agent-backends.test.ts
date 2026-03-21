import test from 'node:test';
import assert from 'node:assert/strict';
import { formatInactiveBackendSummary } from './agent-backends.js';

test('standby backend summary explains resumable parked backends in plain language', () => {
  assert.equal(
    formatInactiveBackendSummary({
      activeBackend: 'codex',
      backendStates: [
        {
          sessionId: 'session-1',
          backend: 'claude',
          nativeSessionName: 'bookshelf',
          nativeResumeRef: 'bookshelf',
          state: 'parked',
          lastActiveAt: null,
          lastHandoffAt: null,
          resumable: true,
        },
        {
          sessionId: 'session-1',
          backend: 'codex',
          nativeSessionName: 'bookshelf',
          nativeResumeRef: 'thread-1',
          state: 'active',
          lastActiveAt: null,
          lastHandoffAt: null,
          resumable: true,
        },
      ],
    }),
    'Standby backend: **Claude** is parked and can be resumed later'
  );
});

test('standby backend summary explains never-started backends', () => {
  assert.equal(
    formatInactiveBackendSummary({
      activeBackend: 'claude',
      backendStates: [
        {
          sessionId: 'session-2',
          backend: 'claude',
          nativeSessionName: 'bookshelf',
          nativeResumeRef: 'bookshelf',
          state: 'active',
          lastActiveAt: null,
          lastHandoffAt: null,
          resumable: true,
        },
        {
          sessionId: 'session-2',
          backend: 'codex',
          nativeSessionName: null,
          nativeResumeRef: null,
          state: 'never_started',
          lastActiveAt: null,
          lastHandoffAt: null,
          resumable: false,
        },
      ],
    }),
    'Standby backend: **Codex** has not been started yet'
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBackendStatus,
  formatInactiveBackendSummary,
  getDefaultAgentBackend,
  getInactiveBackend,
  isBackendEnabled,
  parseEnabledAgentBackends,
} from './agent-backends.js';

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

test('enabled backend parsing removes duplicates and rejects invalid entries', () => {
  assert.deepEqual(
    parseEnabledAgentBackends({ ENABLED_AGENT_BACKENDS: ' claude , codex , claude ' }),
    ['claude', 'codex']
  );
  assert.throws(
    () => parseEnabledAgentBackends({ ENABLED_AGENT_BACKENDS: 'claude,robot' }),
    /Unsupported backend in ENABLED_AGENT_BACKENDS: "robot"/
  );
  assert.equal(isBackendEnabled('codex', { ENABLED_AGENT_BACKENDS: 'claude' }), false);
  assert.equal(isBackendEnabled('claude', { ENABLED_AGENT_BACKENDS: 'claude' }), true);
});

test('default backend selection must respect the enabled backend list', () => {
  assert.equal(
    getDefaultAgentBackend({
      DEFAULT_AGENT_BACKEND: 'codex',
      ENABLED_AGENT_BACKENDS: 'claude,codex',
    }),
    'codex'
  );
  assert.throws(
    () =>
      getDefaultAgentBackend({
        DEFAULT_AGENT_BACKEND: 'codex',
        ENABLED_AGENT_BACKENDS: 'claude',
      }),
    /DEFAULT_AGENT_BACKEND "codex" is not present in ENABLED_AGENT_BACKENDS/
  );
});

test('inactive backend selection and status formatting cover all states', () => {
  assert.equal(getInactiveBackend({ activeBackend: 'claude' }), 'codex');
  assert.equal(getInactiveBackend({ activeBackend: 'codex' }), 'claude');
  assert.equal(formatBackendStatus(null), 'not configured');
  assert.equal(formatBackendStatus({
    sessionId: 'session-3',
    backend: 'claude',
    nativeSessionName: null,
    nativeResumeRef: null,
    state: 'never_started',
    lastActiveAt: null,
    lastHandoffAt: null,
    resumable: false,
  }), 'never started');
  assert.equal(formatBackendStatus({
    sessionId: 'session-3',
    backend: 'claude',
    nativeSessionName: null,
    nativeResumeRef: null,
    state: 'active',
    lastActiveAt: null,
    lastHandoffAt: null,
    resumable: true,
  }), 'active');
  assert.equal(formatBackendStatus({
    sessionId: 'session-3',
    backend: 'claude',
    nativeSessionName: 'bookshelf',
    nativeResumeRef: 'bookshelf',
    state: 'parked',
    lastActiveAt: null,
    lastHandoffAt: null,
    resumable: true,
  }), 'parked and resumable');
  assert.equal(formatBackendStatus({
    sessionId: 'session-3',
    backend: 'codex',
    nativeSessionName: null,
    nativeResumeRef: null,
    state: 'parked',
    lastActiveAt: null,
    lastHandoffAt: null,
    resumable: false,
  }), 'parked');
});

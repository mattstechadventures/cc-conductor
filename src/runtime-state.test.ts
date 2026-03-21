import test from 'node:test';
import assert from 'node:assert/strict';
import { beginSessionTurn, clearRuntimeState, endSessionTurn, isSessionTurnLocked } from './runtime-state.js';

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

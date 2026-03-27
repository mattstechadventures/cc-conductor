import test from 'node:test';
import assert from 'node:assert/strict';
import { getLegacySessionSchemaError, hasLegacyTmuxSessionConstraint } from './session-schema.js';

test('detects legacy tmux_session NOT NULL schemas', () => {
  assert.equal(
    hasLegacyTmuxSessionConstraint([
      { name: 'id', notnull: 0 },
      { name: 'tmux_session', notnull: 1 },
    ]),
    true
  );
});

test('allows compatible tmux_session schemas', () => {
  assert.equal(
    hasLegacyTmuxSessionConstraint([
      { name: 'id', notnull: 0 },
      { name: 'tmux_session', notnull: 0 },
    ]),
    false
  );
  assert.match(getLegacySessionSchemaError(), /data\/conductor\.db/);
});

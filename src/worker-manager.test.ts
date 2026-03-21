import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkerInputFailure } from './worker-manager.js';

test('worker input failure prefers the worker error payload', () => {
  assert.equal(
    buildWorkerInputFailure(500, { error: 'Codex turn failed (exit 1): model unavailable' }),
    'Codex turn failed (exit 1): model unavailable'
  );
});

test('worker input failure falls back to HTTP status when no payload error exists', () => {
  assert.equal(
    buildWorkerInputFailure(409, null),
    'Worker input request failed with HTTP 409.'
  );
});

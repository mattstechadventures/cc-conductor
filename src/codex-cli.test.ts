import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCodexThreadId, parseCodexExecEvents } from './codex-cli.js';

test('parseCodexExecEvents ignores non-JSON lines and keeps JSONL events', () => {
  const events = parseCodexExecEvents([
    'warn: something noisy',
    '{"type":"thread.started","thread_id":"thread-123"}',
    '{"type":"turn.started"}',
  ].join('\n'));

  assert.deepEqual(events, [
    { type: 'thread.started', thread_id: 'thread-123' },
    { type: 'turn.started' },
  ]);
});

test('extractCodexThreadId returns the thread.started id', () => {
  const output = [
    '{"type":"thread.started","thread_id":"019d10b1-4019-7ca2-a9b2-494703ebae6c"}',
    '{"type":"turn.completed"}',
  ].join('\n');

  assert.equal(extractCodexThreadId(output), '019d10b1-4019-7ca2-a9b2-494703ebae6c');
  assert.equal(extractCodexThreadId('{"type":"turn.started"}'), null);
});

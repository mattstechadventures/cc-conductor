import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  extractCodexThreadId,
  parseCodexExecEvents,
  resolveCodexExecutable,
  shouldUseShellForExecutable,
} from './codex-cli.js';

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

test('resolveCodexExecutable prefers Windows runnable shims over extensionless npm stubs', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cli-'));
  const stubBase = path.join(tempDir, 'codex');
  const cmdPath = `${stubBase}.cmd`;

  try {
    fs.writeFileSync(stubBase, '#!/bin/sh\necho raw stub\n');
    fs.writeFileSync(cmdPath, '@echo off\r\necho cmd shim\r\n');

    const resolved = resolveCodexExecutable(stubBase, {
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    }, 'win32');

    assert.equal(resolved, cmdPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('shouldUseShellForExecutable requires a shell for Windows cmd shims', () => {
  assert.equal(shouldUseShellForExecutable('C:\\Users\\claed\\AppData\\Roaming\\npm\\codex.cmd', 'win32'), true);
  assert.equal(shouldUseShellForExecutable('C:\\Tools\\codex.exe', 'win32'), false);
  assert.equal(shouldUseShellForExecutable('/usr/local/bin/codex', 'linux'), false);
});

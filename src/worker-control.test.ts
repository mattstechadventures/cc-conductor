import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import {
  formatRuntimeBuildIdForLog,
  isDiscordMissingPermissionsError,
  readWorkerControlState,
  requestWorkerTerminate,
  terminateWorkerProcess,
} from './worker-control.js';
import { ensureSessionStateDir, getWorkerStatePath, writeJsonFile } from './state.js';

test('runtime build ids are shortened for log readability', () => {
  assert.equal(formatRuntimeBuildIdForLog('1234567890abcdef'), '1234567890ab...');
  assert.equal(formatRuntimeBuildIdForLog(null), '<missing>');
});

test('missing Discord permissions errors are detected', () => {
  assert.equal(isDiscordMissingPermissionsError({ code: 50013 }), true);
  assert.equal(isDiscordMissingPermissionsError({ message: 'Missing Permissions' }), true);
  assert.equal(isDiscordMissingPermissionsError(new Error('boom')), false);
});

test('readWorkerControlState reads worker port and pid from worker.json', () => {
  const sessionId = `worker-control-${Date.now()}`;
  const sessionDir = ensureSessionStateDir(sessionId);

  try {
    writeJsonFile(getWorkerStatePath(sessionId), {
      sessionId,
      workerId: 'worker-1',
      runtimeBuildId: 'build-1',
      port: 18437,
      pid: 48210,
      claudePid: null,
      activeBackend: 'codex',
      terminalBackend: 'none',
      terminalHandle: null,
      workerStatus: 'ready',
      ready: true,
      updatedAt: Date.now(),
      stdoutLogPath: 'stdout.log',
      stderrLogPath: 'stderr.log',
      terminalLogPath: 'terminal.log',
      lastError: null,
      exitCode: null,
    });

    assert.deepEqual(readWorkerControlState(sessionId), {
      port: 18437,
      pid: 48210,
    });
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('requestWorkerTerminate returns ok when the control endpoint accepts the request', async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(null, { status: 202 })) as typeof fetch;

  try {
    const result = await requestWorkerTerminate(18437, 'token-1');
    assert.deepEqual(result, { ok: true });
  } finally {
    global.fetch = originalFetch;
  }
});

test('requestWorkerTerminate returns the HTTP status when the control endpoint rejects the request', async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch;

  try {
    const result = await requestWorkerTerminate(18437, 'token-1');
    assert.deepEqual(result, { ok: false, error: 'HTTP 401' });
  } finally {
    global.fetch = originalFetch;
  }
});

test('terminateWorkerProcess reports already-exited workers without failing', () => {
  const originalKill = process.kill;
  process.kill = ((pid: number) => {
    assert.equal(pid, 48210);
    const err = new Error('missing process') as NodeJS.ErrnoException;
    err.code = 'ESRCH';
    throw err;
  }) as typeof process.kill;

  try {
    assert.deepEqual(terminateWorkerProcess(48210), {
      ok: true,
      alreadyExited: true,
    });
  } finally {
    process.kill = originalKill;
  }
});

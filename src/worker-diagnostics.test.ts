import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { buildWorkerStartupFailure } from './worker-diagnostics.js';
import {
  ensureSessionStateDir,
  getWorkerStatePath,
  getWorkerStdoutLogPath,
  getWorkerStderrLogPath,
  getWorkerTerminalLogPath,
  writeJsonFile,
} from './state.js';
import type { WorkerStateFile } from './types.js';

test('worker timeout diagnostics surface lastError and log paths', () => {
  const sessionId = `worker-diagnostics-${Date.now()}`;
  const sessionDir = ensureSessionStateDir(sessionId);
  const stdoutLogPath = getWorkerStdoutLogPath(sessionId);
  const stderrLogPath = getWorkerStderrLogPath(sessionId);
  const terminalLogPath = getWorkerTerminalLogPath(sessionId);

  try {
    fs.writeFileSync(stdoutLogPath, 'worker boot log');
    fs.writeFileSync(stderrLogPath, '');
    fs.writeFileSync(terminalLogPath, 'claude: unknown option');

    const state: WorkerStateFile = {
      sessionId,
      workerId: 'worker-123',
      port: 30125,
      pid: 1234,
      claudePid: null,
      activeBackend: 'claude',
      terminalBackend: 'pty',
      terminalHandle: null,
      workerStatus: 'exited',
      ready: false,
      updatedAt: Date.now(),
      stdoutLogPath,
      stderrLogPath,
      terminalLogPath,
      lastError: 'Failed to launch PTY-backed Claude runtime',
      exitCode: 1,
    };
    writeJsonFile(getWorkerStatePath(sessionId), state);

    const failure = buildWorkerStartupFailure(sessionId, 'Worker failed to start');
    assert.equal(failure.ready, false);
    assert.match(failure.error || '', /Failed to launch PTY-backed Claude runtime/);
    assert.match(failure.error || '', /Exit code: 1/);
    assert.match(failure.error || '', new RegExp(`data/sessions/${sessionId}/worker.stdout.log`));
    assert.match(failure.error || '', new RegExp(`data/sessions/${sessionId}/terminal.log`));
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

test('worker timeout diagnostics stay compact when terminal output is huge', () => {
  const sessionId = `worker-diagnostics-long-${Date.now()}`;
  const sessionDir = ensureSessionStateDir(sessionId);
  const stdoutLogPath = getWorkerStdoutLogPath(sessionId);
  const stderrLogPath = getWorkerStderrLogPath(sessionId);
  const terminalLogPath = getWorkerTerminalLogPath(sessionId);

  try {
    fs.writeFileSync(stdoutLogPath, '');
    fs.writeFileSync(stderrLogPath, '');
    fs.writeFileSync(terminalLogPath, `error:${'x'.repeat(5000)}`);

    const state: WorkerStateFile = {
      sessionId,
      workerId: 'worker-456',
      port: 30125,
      pid: 1234,
      claudePid: null,
      activeBackend: 'claude',
      terminalBackend: 'pty',
      terminalHandle: null,
      workerStatus: 'exited',
      ready: false,
      updatedAt: Date.now(),
      stdoutLogPath,
      stderrLogPath,
      terminalLogPath,
      lastError: null,
      exitCode: null,
    };
    writeJsonFile(getWorkerStatePath(sessionId), state);

    const failure = buildWorkerStartupFailure(sessionId, 'Worker failed to start');
    assert.ok((failure.error || '').length < 1400);
    assert.match(failure.error || '', /Worker failed to start:/);
    assert.match(failure.error || '', /\.\.\./);
    assert.match(failure.error || '', new RegExp(`data/sessions/${sessionId}/terminal.log`));
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
});

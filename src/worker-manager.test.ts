import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { buildWorkerInputFailure, buildWorkerLaunchPlan, sendInputToWorkerWithContext, terminateSessionWorkerWithContext } from './worker-manager.js';
import type { Session } from './types.js';

const baseSession: Session = {
  id: 'session-worker-manager',
  name: 'worker-manager-test',
  discordChannelId: 'discord-channel',
  discordChannelName: 'worker-manager-test',
  tmuxSession: null,
  projectDir: path.join(os.tmpdir(), 'worker-manager-project'),
  additionalDirs: ['D:\\repos', 'C:\\Users\\claed\\projects\\shared'],
  pid: null,
  status: 'starting',
  createdAt: 1_000_000,
  lastActiveAt: 1_000_000,
  lastCheckpointAt: null,
  checkpointPath: null,
  resumeCount: 0,
  interruptedAt: null,
  indicatorMode: null,
  workerId: null,
  terminalBackend: 'pty',
  terminalHandle: null,
  transportKind: 'channel',
  transportState: 'disconnected',
  activeBackend: 'claude',
  backendStates: [],
  claudeSessionName: 'worker-manager-test',
  claudeResumeRef: 'worker-manager-test',
  workerStatus: 'starting',
};

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

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

test('buildWorkerLaunchPlan keeps Claude workers on structured transport by default', () => {
  const plan = withEnv({
    STRUCTURED_TRANSPORT: undefined,
    TERMINAL_BACKEND: undefined,
    CONDUCTOR_API_PORT: '7842',
    CONDUCTOR_RUNTIME_BUILD_ID: 'build-123',
  }, () =>
    buildWorkerLaunchPlan({
      session: baseSession,
      options: {
        mode: 'resume',
        resumePromptPath: 'resume.md',
      },
      claudeBackend: {
        sessionId: baseSession.id,
        backend: 'claude',
        nativeSessionName: 'bookshelf',
        nativeResumeRef: 'bookshelf',
        state: 'parked',
        lastActiveAt: 123,
        lastHandoffAt: null,
        resumable: true,
      },
      codexBackend: {
        sessionId: baseSession.id,
        backend: 'codex',
        nativeSessionName: null,
        nativeResumeRef: null,
        state: 'never_started',
        lastActiveAt: null,
        lastHandoffAt: null,
        resumable: false,
      },
      workerId: 'worker-1',
      workerToken: 'worker-token',
      channelToken: 'channel-token',
    })
  );

  assert.equal(plan.runtimeBuildId, 'build-123');
  assert.equal(plan.daemonUrl, 'http://127.0.0.1:7842');
  assert.equal(plan.structuredTransport, true);
  assert.equal(plan.terminalBackend, 'pty');
  assert.equal(plan.workerEntry.includes('src/worker.ts'), true);
  assert.equal(plan.workerState.runtimeBuildId, 'build-123');
  assert.equal(plan.workerState.activeBackend, 'claude');
  assert.equal(plan.workerState.workerId, 'worker-1');
  assert.equal(plan.launchEnv.CONDUCTOR_STRUCTURED_TRANSPORT, 'channel');
  assert.equal(plan.launchEnv.CONDUCTOR_CLAUDE_SESSION_NAME, 'bookshelf');
  assert.equal(plan.launchEnv.CONDUCTOR_CLAUDE_RESUME_REF, 'bookshelf');
  assert.equal(plan.launchEnv.CONDUCTOR_CODEX_SESSION_NAME, 'worker-manager-test');
  assert.equal(plan.launchEnv.CONDUCTOR_CODEX_RESUME_REF, '');
  assert.equal(plan.launchEnv.CONDUCTOR_ADDITIONAL_DIRS_JSON, JSON.stringify(baseSession.additionalDirs));
  assert.equal(plan.launchEnv.CONDUCTOR_RESUME_PROMPT_PATH, 'resume.md');
});

test('buildWorkerLaunchPlan switches Codex workers to worker_http transport', () => {
  const plan = withEnv({
    STRUCTURED_TRANSPORT: 'off',
    CONDUCTOR_RUNTIME_BUILD_ID: 'build-456',
  }, () =>
    buildWorkerLaunchPlan({
      session: {
        ...baseSession,
        activeBackend: 'codex',
        terminalBackend: 'pty',
      },
      options: {
        mode: 'new',
        resumePromptPath: '',
      },
      workerId: 'worker-2',
      workerToken: 'worker-token',
      channelToken: 'channel-token',
    })
  );

  assert.equal(plan.structuredTransport, false);
  assert.equal(plan.terminalBackend, 'none');
  assert.equal(plan.workerEntry.includes('src/codex-worker.ts'), true);
  assert.equal(plan.launchEnv.CONDUCTOR_STRUCTURED_TRANSPORT, 'off');
  assert.equal(plan.launchEnv.CONDUCTOR_CODEX_SESSION_NAME, 'worker-manager-test');
  assert.equal(plan.launchEnv.CONDUCTOR_CODEX_RESUME_REF, '');
});

test('sendInputToWorkerWithContext sends worker input and reports transport errors', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const okResult = await sendInputToWorkerWithContext('hello worker', {
    auth: { workerToken: 'worker-token', channelToken: 'channel-token' },
    controlState: { port: 18437, pid: 48210 },
    fetchImpl: (async (input: string | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init: init || {} });
      return new Response(null, { status: 202 });
    }) as typeof fetch,
  });

  assert.deepEqual(okResult, { ok: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:18437/input');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal((requests[0].init.headers as Record<string, string>)['Authorization'], 'Bearer worker-token');
  assert.equal(requests[0].init.body, JSON.stringify({ message: 'hello worker' }));

  const errorResult = await sendInputToWorkerWithContext('hello worker', {
    auth: { workerToken: 'worker-token', channelToken: 'channel-token' },
    controlState: { port: 18437, pid: 48210 },
    fetchImpl: (async () => new Response(JSON.stringify({ error: 'worker rejected input' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch,
  });

  assert.deepEqual(errorResult, { ok: false, error: 'worker rejected input' });

  const unavailable = await sendInputToWorkerWithContext('hello worker', {
    auth: null,
    controlState: { port: null, pid: null },
  });
  assert.deepEqual(unavailable, { ok: false, error: 'No worker transport is available.' });
});

test('terminateSessionWorkerWithContext prefers the worker control endpoint and falls back to process termination', async () => {
  const warnings: string[] = [];
  const clearCalls: string[] = [];
  const cleanupCalls: Array<{ id: string; structured: boolean }> = [];
  const terminateCalls: Array<{ port: number; token: string }> = [];
  const processCalls: Array<number | null> = [];
  const session: Session = {
    ...baseSession,
    id: 'session-term',
    name: 'terminate-test',
    transportKind: 'channel',
  };

  await terminateSessionWorkerWithContext(session, {
    auth: { workerToken: 'worker-token', channelToken: 'channel-token' },
    controlState: { port: 18437, pid: 48210 },
    requestTerminate: async (port, token) => {
      terminateCalls.push({ port, token });
      return { ok: false, error: 'HTTP 401' };
    },
    terminateProcess: (pid) => {
      processCalls.push(pid);
      return { ok: false, alreadyExited: false, error: 'missing process' };
    },
    clearRuntime: sessionId => {
      clearCalls.push(sessionId);
    },
    cleanupRegisteredChannelServer: (targetSession, structured) => {
      cleanupCalls.push({ id: targetSession.id, structured });
    },
    logger: {
      warn: message => warnings.push(message),
    },
  });

  assert.deepEqual(terminateCalls, [{ port: 18437, token: 'worker-token' }]);
  assert.deepEqual(processCalls, [48210]);
  assert.deepEqual(clearCalls, ['session-term']);
  assert.deepEqual(cleanupCalls, [{ id: 'session-term', structured: true }]);
  assert.deepEqual(warnings, ['Failed to terminate worker for terminate-test: HTTP 401']);
});

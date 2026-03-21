import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeLaunch } from './pairing.js';
import type { Session } from './types.js';

const baseSession: Session = {
  id: 'session-1',
  name: 'test2',
  discordChannelId: 'discord-channel',
  discordChannelName: 'test2',
  tmuxSession: null,
  projectDir: 'D:\\repos',
  additionalDirs: [],
  pid: null,
  status: 'starting',
  createdAt: 0,
  lastActiveAt: 0,
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
  claudeSessionName: 'test2',
  claudeResumeRef: 'test2',
  workerStatus: 'starting',
};

test('structured transport launches Claude with the session-scoped development channel selector', () => {
  const plan = buildClaudeLaunch(baseSession, {
    mode: 'new',
    structuredTransport: true,
  });

  assert.deepEqual(plan.args, [
    '--name',
    'test2',
    '--permission-mode',
    'acceptEdits',
    '--dangerously-load-development-channels',
    'server:conductor-discord-session-1',
  ]);
});

test('additional directories are passed through Claude launch args', () => {
  const plan = buildClaudeLaunch({
    ...baseSession,
    additionalDirs: ['D:\\repos', 'C:\\Users\\claed\\projects\\shared'],
  }, {
    mode: 'new',
    structuredTransport: false,
  });

  assert.deepEqual(plan.args, [
    '--name',
    'test2',
    '--permission-mode',
    'acceptEdits',
    '--add-dir',
    'D:\\repos',
    '--add-dir',
    'C:\\Users\\claed\\projects\\shared',
  ]);
});

test('fallback transport does not request the structured channel bridge', () => {
  const plan = buildClaudeLaunch(baseSession, {
    mode: 'new',
    structuredTransport: false,
  });

  assert.deepEqual(plan.args, [
    '--name',
    'test2',
    '--permission-mode',
    'acceptEdits',
  ]);
});

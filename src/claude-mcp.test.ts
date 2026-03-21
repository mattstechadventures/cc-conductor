import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { buildSessionChannelServerConfig, getSessionChannelServerName } from './claude-mcp.js';
import type { Session } from './types.js';

const require = createRequire(import.meta.url);

const baseSession: Session = {
  id: 'session_1',
  name: 'test5',
  discordChannelId: 'discord-channel',
  discordChannelName: 'test5',
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
  claudeSessionName: 'test5',
  claudeResumeRef: 'test5',
  workerStatus: 'starting',
};

test('session channel server names remain Claude-safe and deterministic', () => {
  assert.equal(getSessionChannelServerName('GqMzP_8b'), 'conductor-discord-gqmzp-8b');
});

test('session channel servers use the repo-local tsx loader and project-local Claude scope', () => {
  const config = buildSessionChannelServerConfig(baseSession, {
    daemonUrl: 'http://127.0.0.1:7842',
    channelToken: 'token',
    resumePromptPath: '',
  }, {
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    repoRoot: 'D:\\Repositories\\cc-conductor',
    platform: 'win32',
  });

  assert.deepEqual(config, {
    command: 'C:/Program Files/nodejs/node.exe',
    args: [
      '--import',
      pathToFileURL(path.join(path.dirname(require.resolve('tsx/package.json')), 'dist', 'loader.mjs')).href,
      'D:/Repositories/cc-conductor/src/channel-server.ts',
    ],
    env: {
      CONDUCTOR_DAEMON_URL: 'http://127.0.0.1:7842',
      CONDUCTOR_SESSION_ID: 'session_1',
      CONDUCTOR_CHANNEL_TOKEN: 'token',
      CONDUCTOR_CHANNEL_ID: 'discord-channel',
      CONDUCTOR_SESSION_NAME: 'test5',
      CONDUCTOR_PROJECT_DIR: 'D:\\repos',
      CONDUCTOR_RESUME_PROMPT_PATH: '',
      CONDUCTOR_CHANNEL_SERVER_NAME: 'conductor-discord-session-1',
    },
  });
});

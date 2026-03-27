import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  buildSessionChannelServerConfig,
  getSessionChannelServerName,
  registerSessionChannelServer,
  unregisterSessionChannelServer,
} from './claude-mcp.js';
import type { Session } from './types.js';

const require = createRequire(import.meta.url);
const TMP_ROOT = process.platform === 'win32' ? os.tmpdir() : '/tmp';

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
  activeBackend: 'claude',
  backendStates: [],
  claudeSessionName: 'test5',
  claudeResumeRef: 'test5',
  workerStatus: 'starting',
};

function createMockClaudeBinary(tempDir: string): string {
  const scriptPath = path.join(tempDir, 'mock-claude.sh');
  const script = `#!/bin/sh
set -eu

log_file="\${MOCK_CLAUDE_LOG:-}"
if [ -n "$log_file" ]; then
  for arg in "$@"; do
    printf '%s\n' "$arg" >> "$log_file"
  done
fi

if [ "\${1:-}" = "mcp" ] && [ "\${2:-}" = "add-json" ]; then
  status="\${MOCK_CLAUDE_ADD_STATUS:-0}"
  if [ "$status" != "0" ]; then
    printf '%s\n' "\${MOCK_CLAUDE_ADD_STDERR:-add failed}" >&2
  fi
  exit "$status"
fi

if [ "\${1:-}" = "mcp" ] && [ "\${2:-}" = "remove" ]; then
  case "\${MOCK_CLAUDE_REMOVE_MODE:-ok}" in
    missing)
      printf '%s\n' "No MCP server found with name: \${5:-}" >&2
      exit 1
      ;;
    fail)
      printf '%s\n' "\${MOCK_CLAUDE_REMOVE_STDERR:-boom}" >&2
      exit 1
      ;;
  esac
  exit 0
fi

exit "\${MOCK_CLAUDE_DEFAULT_STATUS:-0}"
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  fs.chmodSync(scriptPath, 0o755);

  if (process.platform === 'win32') {
    const wrapperPath = path.join(tempDir, 'mock-claude.cmd');
    fs.writeFileSync(
      wrapperPath,
      '@echo off\r\nnode "%~dp0mock-claude.sh" %*\r\n',
      'utf-8'
    );
    return wrapperPath;
  }

  return scriptPath;
}

async function withClaudeEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => T | Promise<T>
): Promise<T> {
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
    return await fn();
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

test('registerSessionChannelServer uses the Claude CLI add-json command', async () => {
  const tempDir = fs.mkdtempSync(path.join(TMP_ROOT, 'claude-mcp-register-'));
  const logPath = path.join(tempDir, 'claude.log');
  const binaryPath = createMockClaudeBinary(tempDir);
  const session = { ...baseSession, id: `session_${Date.now()}`, projectDir: tempDir };

  try {
    const serverName = await withClaudeEnv({
      CONDUCTOR_RESOLVED_CLAUDE_BIN: binaryPath,
      MOCK_CLAUDE_LOG: logPath,
      MOCK_CLAUDE_REMOVE_MODE: 'missing',
    }, () => registerSessionChannelServer(session, {
      daemonUrl: 'http://127.0.0.1:7842',
      channelToken: 'token',
      resumePromptPath: 'resume.md',
    }));

    assert.equal(serverName, `conductor-discord-${session.id.toLowerCase().replace(/_/g, '-')}`);
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 11);
    const removeCall = lines.slice(0, 5);
    const addCall = lines.slice(5, 11);
    assert.deepEqual(removeCall, ['mcp', 'remove', '--scope', 'local', serverName]);
    assert.deepEqual(addCall.slice(0, 5), ['mcp', 'add-json', '--scope', 'local', serverName]);
    const config = JSON.parse(addCall[5] as string) as { env: Record<string, string> };
    assert.equal(config.env.CONDUCTOR_CHANNEL_SERVER_NAME, serverName);
    assert.equal(config.env.CONDUCTOR_RESUME_PROMPT_PATH, 'resume.md');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('unregisterSessionChannelServer ignores the missing-server response when requested', async () => {
  const tempDir = fs.mkdtempSync(path.join(TMP_ROOT, 'claude-mcp-remove-'));
  const binaryPath = createMockClaudeBinary(tempDir);
  const session = { id: `session_${Date.now()}`, projectDir: tempDir };

  try {
    await withClaudeEnv({
      CONDUCTOR_RESOLVED_CLAUDE_BIN: binaryPath,
      MOCK_CLAUDE_REMOVE_MODE: 'missing',
    }, () => unregisterSessionChannelServer(session, { ignoreMissing: true }));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('registerSessionChannelServer surfaces CLI failures with context', async () => {
  const tempDir = fs.mkdtempSync(path.join(TMP_ROOT, 'claude-mcp-register-fail-'));
  const binaryPath = createMockClaudeBinary(tempDir);
  const session = { ...baseSession, id: `session_${Date.now()}`, projectDir: tempDir };

  try {
    await assert.rejects(
      withClaudeEnv({
        CONDUCTOR_RESOLVED_CLAUDE_BIN: binaryPath,
        MOCK_CLAUDE_REMOVE_MODE: 'missing',
        MOCK_CLAUDE_ADD_STATUS: '1',
        MOCK_CLAUDE_ADD_STDERR: 'register exploded',
      }, () => registerSessionChannelServer(session, {
        daemonUrl: 'http://127.0.0.1:7842',
        channelToken: 'token',
        resumePromptPath: '',
      })),
      /Failed to register Claude MCP server .*register exploded/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('unregisterSessionChannelServer surfaces unexpected failures', async () => {
  const tempDir = fs.mkdtempSync(path.join(TMP_ROOT, 'claude-mcp-remove-fail-'));
  const binaryPath = createMockClaudeBinary(tempDir);
  const session = { id: `session_${Date.now()}`, projectDir: tempDir };

  try {
    await assert.rejects(
      withClaudeEnv({
        CONDUCTOR_RESOLVED_CLAUDE_BIN: binaryPath,
        MOCK_CLAUDE_REMOVE_MODE: 'fail',
        MOCK_CLAUDE_REMOVE_STDERR: 'remove exploded',
      }, () => unregisterSessionChannelServer(session)),
      /Failed to remove Claude MCP server .*remove exploded/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

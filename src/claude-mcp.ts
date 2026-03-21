import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { getRepoRoot } from './state.js';
import type { Session } from './types.js';

const require = createRequire(import.meta.url);
const SESSION_CHANNEL_SERVER_PREFIX = 'conductor-discord-';

export interface ClaudeMcpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface ClaudeMcpCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function getSessionChannelServerName(sessionId: string): string {
  return `${SESSION_CHANNEL_SERVER_PREFIX}${sessionId.toLowerCase().replace(/_/g, '-')}`;
}

export function buildSessionChannelServerConfig(
  session: Pick<Session, 'id' | 'name' | 'discordChannelId' | 'projectDir'>,
  options: {
    daemonUrl: string;
    channelToken: string;
    resumePromptPath: string;
  },
  runtime: {
    nodePath?: string;
    repoRoot?: string;
    platform?: NodeJS.Platform;
  } = {}
): ClaudeMcpServerConfig {
  const repoRoot = runtime.repoRoot || getRepoRoot();
  const platform = runtime.platform || process.platform;

  return {
    command: normalizePathForClaude(runtime.nodePath || process.execPath, platform),
    args: [
      '--import',
      getTsxLoaderSpecifier(),
      normalizePathForClaude(path.join(repoRoot, 'src', 'channel-server.ts'), platform),
    ],
    env: {
      CONDUCTOR_DAEMON_URL: options.daemonUrl,
      CONDUCTOR_SESSION_ID: session.id,
      CONDUCTOR_CHANNEL_TOKEN: options.channelToken,
      CONDUCTOR_CHANNEL_ID: session.discordChannelId,
      CONDUCTOR_SESSION_NAME: session.name,
      CONDUCTOR_PROJECT_DIR: session.projectDir,
      CONDUCTOR_RESUME_PROMPT_PATH: options.resumePromptPath,
      CONDUCTOR_CHANNEL_SERVER_NAME: getSessionChannelServerName(session.id),
    },
  };
}

export function registerSessionChannelServer(
  session: Pick<Session, 'id' | 'name' | 'discordChannelId' | 'projectDir'>,
  options: {
    daemonUrl: string;
    channelToken: string;
    resumePromptPath: string;
  }
): string {
  const serverName = getSessionChannelServerName(session.id);
  unregisterSessionChannelServer(session, { ignoreMissing: true });

  const result = runClaudeMcpCommand(session, [
    'mcp',
    'add-json',
    '--scope',
    'local',
    serverName,
    JSON.stringify(buildSessionChannelServerConfig(session, options)),
  ]);

  if (result.status !== 0) {
    throw new Error(formatClaudeMcpFailure(`Failed to register Claude MCP server ${serverName}`, result));
  }

  return serverName;
}

export function unregisterSessionChannelServer(
  session: Pick<Session, 'id' | 'projectDir'>,
  options: {
    ignoreMissing?: boolean;
  } = {}
): void {
  const serverName = getSessionChannelServerName(session.id);
  const result = runClaudeMcpCommand(session, [
    'mcp',
    'remove',
    '--scope',
    'local',
    serverName,
  ]);

  if (result.status === 0) {
    return;
  }

  if (options.ignoreMissing && isMissingServerError(result, serverName)) {
    return;
  }

  throw new Error(formatClaudeMcpFailure(`Failed to remove Claude MCP server ${serverName}`, result));
}

function runClaudeMcpCommand(
  session: Pick<Session, 'projectDir'>,
  args: string[]
): ClaudeMcpCommandResult {
  const result = spawnSync(getClaudeCommand(), args, {
    cwd: session.projectDir,
    env: process.env,
    encoding: 'utf-8',
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`Failed to execute Claude Code: ${result.error.message}`);
  }

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function getClaudeCommand(): string {
  return process.env.CONDUCTOR_RESOLVED_CLAUDE_BIN || process.env.CLAUDE_BIN || 'claude';
}

function getTsxLoaderSpecifier(): string {
  const tsxPackagePath = require.resolve('tsx/package.json');
  const loaderPath = path.join(path.dirname(tsxPackagePath), 'dist', 'loader.mjs');
  return pathToFileURL(loaderPath).href;
}

function normalizePathForClaude(value: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return value;
  return value.replace(/\\/g, '/');
}

function isMissingServerError(result: ClaudeMcpCommandResult, serverName: string): boolean {
  const output = `${result.stdout}\n${result.stderr}`;
  return output.includes(`No MCP server found with name: ${serverName}`) ||
    output.includes(`No project-local MCP server found with name: ${serverName}`) ||
    output.includes(`No user MCP server found with name: ${serverName}`);
}

function formatClaudeMcpFailure(prefix: string, result: ClaudeMcpCommandResult): string {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (!output) return prefix;
  return `${prefix}: ${output}`;
}

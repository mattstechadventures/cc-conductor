import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import type { ClaudeVersion } from './types.js';

const MINIMUM_CLAUDE_VERSION: ClaudeVersion = {
  major: 2,
  minor: 1,
  patch: 80,
};

export interface ClaudeCliValidation {
  configuredBin: string;
  resolvedPath: string;
  versionText: string;
  version: ClaudeVersion;
}

export function getConfiguredClaudeBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_BIN || 'claude';
}

export function getMinimumClaudeVersion(): ClaudeVersion {
  return MINIMUM_CLAUDE_VERSION;
}

export function formatClaudeVersion(version: ClaudeVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function parseClaudeVersion(text: string): ClaudeVersion | null {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

export function compareClaudeVersions(left: ClaudeVersion, right: ClaudeVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

export function resolveClaudeExecutable(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const command = input.trim();
  if (!command) {
    throw new Error('CLAUDE_BIN is empty.');
  }

  if (path.isAbsolute(command) || command.includes(path.sep) || command.includes('/') || command.includes('\\')) {
    const direct = resolveDirectExecutable(command, platform, env);
    if (direct) return direct;
    throw new Error(`Claude Code executable not found at "${command}".`);
  }

  const pathEnv = env.PATH || '';
  const directories = pathEnv.split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const resolved = resolveDirectExecutable(path.join(directory, command), platform, env);
    if (resolved) return resolved;
  }

  throw new Error(`Unable to resolve CLAUDE_BIN "${command}" on PATH.`);
}

export function validateClaudeCli(env: NodeJS.ProcessEnv = process.env): ClaudeCliValidation {
  const configuredBin = getConfiguredClaudeBin(env);
  const resolvedPath = resolveClaudeExecutable(configuredBin, env);
  const versionProcess = spawnSync(resolvedPath, ['--version'], {
    env,
    encoding: 'utf-8',
  });

  if (versionProcess.error) {
    throw new Error(`Failed to execute Claude Code at "${resolvedPath}": ${versionProcess.error.message}`);
  }

  const versionText = `${versionProcess.stdout || ''}${versionProcess.stderr || ''}`.trim();
  const version = parseClaudeVersion(versionText);
  if (!version) {
    throw new Error(`Unable to parse Claude Code version from "${versionText || '(empty output)'}" at "${resolvedPath}".`);
  }

  if (compareClaudeVersions(version, MINIMUM_CLAUDE_VERSION) < 0) {
    throw new Error(
      `Unsupported Claude Code version ${formatClaudeVersion(version)} at "${resolvedPath}". ` +
      `Conductor requires ${formatClaudeVersion(MINIMUM_CLAUDE_VERSION)} or newer. Upgrade Claude Code and restart Conductor.`
    );
  }

  return {
    configuredBin,
    resolvedPath,
    versionText,
    version,
  };
}

function resolveDirectExecutable(
  input: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string | null {
  for (const candidate of buildExecutableCandidates(input, platform, env)) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function buildExecutableCandidates(
  input: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): string[] {
  if (platform !== 'win32') {
    return [input];
  }

  const ext = path.extname(input);
  if (ext) {
    return [input];
  }

  const rawPathExt = env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  const extensions = rawPathExt.split(';').filter(Boolean);
  return [
    ...extensions.map(extension => `${input}${extension.toLowerCase()}`),
    ...extensions.map(extension => `${input}${extension.toUpperCase()}`),
    input,
  ];
}

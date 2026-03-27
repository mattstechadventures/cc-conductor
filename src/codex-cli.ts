import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

export interface CodexCliValidation {
  configuredBin: string;
  resolvedPath: string;
  versionText: string;
  execHelpText: string;
  resumeHelpText: string;
}

export interface CodexExecEvent {
  type: string;
  thread_id?: string;
  [key: string]: unknown;
}

export function getConfiguredCodexBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_BIN || 'codex';
}

export function resolveCodexExecutable(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const command = input.trim();
  if (!command) {
    throw new Error('CODEX_BIN is empty.');
  }

  if (path.isAbsolute(command) || command.includes(path.sep) || command.includes('/') || command.includes('\\')) {
    const direct = resolveDirectExecutable(command, platform, env);
    if (direct) return direct;
    throw new Error(`Codex executable not found at "${command}".`);
  }

  const pathEnv = env.PATH || '';
  const directories = pathEnv.split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const resolved = resolveDirectExecutable(path.join(directory, command), platform, env);
    if (resolved) return resolved;
  }

  throw new Error(`Unable to resolve CODEX_BIN "${command}" on PATH.`);
}

export function validateCodexCli(env: NodeJS.ProcessEnv = process.env): CodexCliValidation {
  const configuredBin = getConfiguredCodexBin(env);
  const resolvedPath = resolveCodexExecutable(configuredBin, env);
  const versionText = runHelpCommand(resolvedPath, ['--version'], env, 'Codex version probe');
  const execHelpText = runHelpCommand(resolvedPath, ['exec', '--help'], env, 'codex exec --help');
  const resumeHelpText = runHelpCommand(resolvedPath, ['exec', 'resume', '--help'], env, 'codex exec resume --help');

  if (!execHelpText.includes('--json')) {
    throw new Error(`Codex CLI at "${resolvedPath}" does not advertise exec --json support.`);
  }
  if (!execHelpText.includes('--output-last-message')) {
    throw new Error(`Codex CLI at "${resolvedPath}" does not advertise exec --output-last-message support.`);
  }
  if (!resumeHelpText.includes('--json')) {
    throw new Error(`Codex CLI at "${resolvedPath}" does not advertise exec resume --json support.`);
  }
  if (!resumeHelpText.includes('--output-last-message')) {
    throw new Error(`Codex CLI at "${resolvedPath}" does not advertise exec resume --output-last-message support.`);
  }

  return {
    configuredBin,
    resolvedPath,
    versionText,
    execHelpText,
    resumeHelpText,
  };
}

export function parseCodexExecEvents(output: string): CodexExecEvent[] {
  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      if (!line.startsWith('{')) {
        return null;
      }

      try {
        return JSON.parse(line) as CodexExecEvent;
      } catch {
        return null;
      }
    })
    .filter((event): event is CodexExecEvent => event !== null);
}

export function extractCodexThreadId(output: string): string | null {
  const started = parseCodexExecEvents(output).find(event => event.type === 'thread.started');
  return typeof started?.thread_id === 'string' && started.thread_id ? started.thread_id : null;
}

export function shouldUseShellForExecutable(
  executable: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'win32') {
    return false;
  }

  const ext = path.extname(executable).toLowerCase();
  return ext === '.cmd' || ext === '.bat';
}

function runHelpCommand(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  label: string
): string {
  const result = spawnSync(executable, args, {
    env,
    encoding: 'utf-8',
    shell: shouldUseShellForExecutable(executable),
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`Failed to execute ${label} at "${executable}": ${result.error.message}`);
  }

  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.status !== 0) {
    throw new Error(`Failed to execute ${label} at "${executable}": ${output || `exit ${result.status}`}`);
  }

  return output;
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

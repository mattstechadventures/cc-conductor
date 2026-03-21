import fs from 'fs';
import path from 'path';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import * as pty from 'node-pty';
import {
  capturePaneOutput,
  createTmuxSession,
  getSessionPid,
  killTmuxSession,
  sendEnter as sendTmuxEnter,
  sendKeys as sendTmuxKeys,
  sendTmuxRaw,
  tmuxSessionExists,
} from './tmux.js';
import { buildClaudeLaunch } from './pairing.js';
import { formatCommand } from './command-prefix.js';
import { logger } from './logger.js';
import { writeJsonFile } from './state.js';
import { analyzeTerminalOutput } from './worker-prompts.js';
import type {
  Session,
  TerminalBackend,
  WorkerHeartbeat,
  WorkerLaunchMode,
  WorkerRegistration,
  WorkerStateFile,
  WorkerStatus,
} from './types.js';

const sessionId = requiredEnv('CONDUCTOR_SESSION_ID');
const workerId = requiredEnv('CONDUCTOR_WORKER_ID');
const workerToken = requiredEnv('CONDUCTOR_WORKER_TOKEN');
const daemonUrl = requiredEnv('CONDUCTOR_DAEMON_URL');
const workerStatePath = requiredEnv('CONDUCTOR_WORKER_STATE_PATH');
const workerStateDir = path.dirname(workerStatePath);
const sessionName = requiredEnv('CONDUCTOR_SESSION_NAME');
const projectDir = requiredEnv('CONDUCTOR_PROJECT_DIR');
const additionalDirs = parseAdditionalDirs(process.env.CONDUCTOR_ADDITIONAL_DIRS_JSON);
const claudeSessionName = requiredEnv('CONDUCTOR_CLAUDE_SESSION_NAME');
const claudeResumeRef = requiredEnv('CONDUCTOR_CLAUDE_RESUME_REF');
const mode = requiredEnv('CONDUCTOR_WORKER_MODE') as WorkerLaunchMode;
const stdoutLogPath = process.env.CONDUCTOR_WORKER_STDOUT_LOG_PATH || path.join(workerStateDir, 'worker.stdout.log');
const stderrLogPath = process.env.CONDUCTOR_WORKER_STDERR_LOG_PATH || path.join(workerStateDir, 'worker.stderr.log');
const terminalLogPath = process.env.CONDUCTOR_TERMINAL_LOG_PATH || path.join(workerStateDir, 'terminal.log');
const resumePromptPath = process.env.CONDUCTOR_RESUME_PROMPT_PATH || '';
const structuredTransport = process.env.CONDUCTOR_STRUCTURED_TRANSPORT === 'channel';
const configuredBackend = (process.env.CONDUCTOR_TERMINAL_BACKEND as TerminalBackend | undefined) || 'pty';
const terminalBackend: TerminalBackend = configuredBackend === 'tmux' ? 'tmux' : 'pty';
const tmuxSessionName = process.env.CONDUCTOR_TMUX_SESSION || `conductor-${sessionName}`;

const session: Session = {
  id: sessionId,
  name: sessionName,
  discordChannelId: '',
  discordChannelName: '',
  tmuxSession: tmuxSessionName,
  projectDir,
  additionalDirs,
  pid: null,
  status: 'starting',
  createdAt: Date.now(),
  lastActiveAt: Date.now(),
  lastCheckpointAt: null,
  checkpointPath: null,
  resumeCount: 0,
  interruptedAt: null,
  indicatorMode: null,
  workerId,
  terminalBackend,
  terminalHandle: terminalBackend === 'tmux' ? tmuxSessionName : null,
  transportKind: structuredTransport ? 'channel' : 'pty_fallback',
  transportState: 'disconnected',
  claudeSessionName,
  claudeResumeRef,
  workerStatus: 'starting',
};

let workerStatus: WorkerStatus = 'starting';
let serverPort = 0;
let ready = false;
let shuttingDown = false;
let lastObservedOutput = '';
let lastTrustActionAt = 0;
let lastDevelopmentChannelActionAt = 0;
let lastPermissionActionAt = 0;
let lastBlockedDirectoryNoticeAt = 0;
let lastBlockedDirectorySignature = '';
let lastError: string | null = null;
let lastExitCode: number | null = null;
let ptyProcess: pty.IPty | null = null;
let tmuxPollTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let terminalLogStream: fs.WriteStream | null = null;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function parseAdditionalDirs(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(workerStateDir, { recursive: true });
  terminalLogStream = fs.createWriteStream(terminalLogPath, { flags: 'a' });

  const server = createServer(async (req, res) => {
    try {
      if (!authorize(req)) {
        respondJson(res, 401, { ok: false, error: 'Unauthorized' });
        return;
      }

      if (req.method === 'GET' && req.url === '/health') {
        respondJson(res, 200, {
          ok: true,
          workerId,
          workerStatus,
          ready,
          terminalBackend,
          terminalHandle: getTerminalHandle(),
          claudePid: getClaudePid(),
        });
        return;
      }

      if (req.method === 'POST' && req.url === '/input') {
        const body = await readJsonBody(req) as { message?: string };
        if (!body.message) {
          respondJson(res, 400, { ok: false, error: 'message is required' });
          return;
        }
        await sendMessage(body.message);
        respondJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && req.url === '/control/terminate') {
        respondJson(res, 202, { ok: true });
        await shutdown('terminate-request');
        return;
      }

      respondJson(res, 404, { ok: false, error: 'Not found' });
    } catch (err: any) {
      respondJson(res, 500, { ok: false, error: err.message });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Failed to determine worker port');
      }
      serverPort = address.port;
      resolve();
    });
  });

  writeStateFile();
  await registerWithDaemon();
  startHeartbeat();
  await startClaudeRuntime();

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch(err => logger.error(`Worker shutdown failed: ${err.message}`));
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT').catch(err => logger.error(`Worker shutdown failed: ${err.message}`));
  });
}

async function startClaudeRuntime(): Promise<void> {
  const launch = buildClaudeLaunch(session, {
    mode,
    structuredTransport,
  });

  if (terminalBackend === 'tmux') {
    try {
      createTmuxSession(tmuxSessionName, projectDir);
      sendTmuxKeys(tmuxSessionName, shellEscapeCommand(launch.command, launch.args));
    } catch (err: any) {
      recordFailure(`Failed to launch tmux-backed Claude runtime: ${err.message}`, null);
      throw err;
    }
    tmuxPollTimer = setInterval(() => {
      try {
        if (!tmuxSessionExists(tmuxSessionName)) {
          void handleRuntimeExit();
          return;
        }
        observeOutput(capturePaneOutput(tmuxSessionName, 80));
      } catch {
        // best effort
      }
    }, 1_000);
    return;
  }

  try {
    ptyProcess = pty.spawn(launch.command, launch.args, {
      name: 'xterm-color',
      cols: 160,
      rows: 48,
      cwd: projectDir,
      env: process.env as Record<string, string>,
    });
  } catch (err: any) {
    recordFailure(`Failed to launch PTY-backed Claude runtime: ${err.message}`, null);
    throw err;
  }

  ptyProcess.onData((data) => {
    appendTerminalLog(data);
    observeOutput(data);
  });

  ptyProcess.onExit((event) => {
    void handleRuntimeExit(event.exitCode);
  });
}

function observeOutput(chunk: string): void {
  if (!chunk) return;
  lastObservedOutput = `${lastObservedOutput}${chunk}`.slice(-30_000);
  const signals = analyzeTerminalOutput(lastObservedOutput);

  if (signals.isOutsideAllowedDirectoryPrompt) {
    const signature = signals.blockedDirectoryPath || 'outside-allowed-directories';
    if (
      signature !== lastBlockedDirectorySignature ||
      Date.now() - lastBlockedDirectoryNoticeAt > 30_000
    ) {
      lastBlockedDirectorySignature = signature;
      lastBlockedDirectoryNoticeAt = Date.now();
      logger.info(`Worker ${workerId} rejected outside-directory access prompt`);
      void postBlockedDirectoryNotice(signals.blockedDirectoryPath);
    }
    lastObservedOutput = '';
    void sendEscape();
    return;
  }

  if (Date.now() - lastPermissionActionAt > 3_000 && signals.isPermissionPrompt) {
    lastPermissionActionAt = Date.now();
    logger.info(`Worker ${workerId} auto-accepted permission prompt`);
    lastObservedOutput = '';
    if (signals.permissionPromptAction === 'down-enter') {
      void sendRawDownAndEnter();
    } else {
      void sendEnter();
    }
    return;
  }

  if (!ready && signals.isReadyPrompt) {
    ready = true;
    workerStatus = 'ready';
    writeStateFile();
    void heartbeat();
    if (!structuredTransport && mode === 'resume-prompt' && resumePromptPath) {
      const promptName = path.basename(resumePromptPath);
      void sendMessage(`Read ${promptName} and resume the session described in it. Acknowledge what you were working on.`);
    }
  }

  if (!ready && Date.now() - lastTrustActionAt > 3_000 && signals.isTrustPrompt) {
    lastTrustActionAt = Date.now();
    logger.info(`Worker ${workerId} auto-confirmed trust prompt`);
    lastObservedOutput = '';
    void sendEnter();
    return;
  }

  if (!ready && Date.now() - lastDevelopmentChannelActionAt > 3_000 && signals.isDevelopmentChannelPrompt) {
    lastDevelopmentChannelActionAt = Date.now();
    logger.info(`Worker ${workerId} auto-confirmed development channel prompt`);
    lastObservedOutput = '';
    void sendEnter();
    return;
  }
}

async function sendMessage(message: string): Promise<void> {
  if (terminalBackend === 'tmux') {
    sendTmuxKeys(tmuxSessionName, message);
    return;
  }

  if (!ptyProcess) throw new Error('PTY process is not available');
  ptyProcess.write(message);
  await sleep(150);
  ptyProcess.write('\r');
}

async function sendEnter(): Promise<void> {
  if (terminalBackend === 'tmux') {
    sendTmuxEnter(tmuxSessionName);
    return;
  }

  if (!ptyProcess) throw new Error('PTY process is not available');
  ptyProcess.write('\r');
}

async function sendRawDownAndEnter(): Promise<void> {
  if (terminalBackend === 'tmux') {
    sendTmuxRaw(tmuxSessionName, 'Down');
    await sleep(300);
    sendTmuxEnter(tmuxSessionName);
    return;
  }

  if (!ptyProcess) throw new Error('PTY process is not available');
  ptyProcess.write('\x1b[B');
  await sleep(300);
  ptyProcess.write('\r');
}

async function sendEscape(): Promise<void> {
  if (terminalBackend === 'tmux') {
    sendTmuxRaw(tmuxSessionName, 'Escape');
    return;
  }

  if (!ptyProcess) throw new Error('PTY process is not available');
  ptyProcess.write('\x1b');
}

async function postBlockedDirectoryNotice(blockedDirectoryPath: string | null): Promise<void> {
  const sessionCommand = blockedDirectoryPath
    ? formatCommand(`add-dir ${blockedDirectoryPath}`)
    : formatCommand('add-dir <path>');
  const orchestratorCommand = blockedDirectoryPath
    ? formatCommand(`add-dir ${sessionName} ${blockedDirectoryPath}`)
    : formatCommand(`add-dir ${sessionName} <path>`);
  const message = blockedDirectoryPath
    ? `Claude requested access to \`${blockedDirectoryPath}\`, but that path is outside this session's allowed directories. Use \`${orchestratorCommand}\` in #${process.env.ORCHESTRATOR_CHANNEL_NAME || 'orchestrator'} or \`${sessionCommand}\` in this session channel, then retry.`
    : `Claude requested access outside this session's allowed directories. Use \`${orchestratorCommand}\` in #${process.env.ORCHESTRATOR_CHANNEL_NAME || 'orchestrator'} or \`${sessionCommand}\` in this session channel, then retry.`;

  await fetch(`${daemonUrl}/internal/sessions/${sessionId}/worker/notice`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${workerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message }),
  }).catch(() => {});
}

async function registerWithDaemon(): Promise<void> {
  const registration: WorkerRegistration = {
    workerId,
    port: serverPort,
    pid: process.pid,
    claudePid: getClaudePid(),
    terminalHandle: getTerminalHandle(),
    terminalBackend,
    workerStatus,
  };

  await fetch(`${daemonUrl}/internal/sessions/${sessionId}/worker/register`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${workerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(registration),
  }).catch(() => {});
}

function startHeartbeat(): void {
  heartbeatTimer = setInterval(() => {
    void heartbeat();
  }, 5_000);
}

async function heartbeat(): Promise<void> {
  const heartbeatPayload: WorkerHeartbeat = {
    workerId,
    port: serverPort,
    pid: process.pid,
    claudePid: getClaudePid(),
    terminalHandle: getTerminalHandle(),
    terminalBackend,
    workerStatus,
  };

  writeStateFile();
  await fetch(`${daemonUrl}/internal/sessions/${sessionId}/worker/heartbeat`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${workerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(heartbeatPayload),
  }).catch(() => {});
}

function writeStateFile(): void {
  const state: WorkerStateFile = {
    sessionId,
    workerId,
    port: serverPort || null,
    pid: process.pid,
    claudePid: getClaudePid(),
    terminalBackend,
    terminalHandle: getTerminalHandle(),
    workerStatus,
    ready,
    stdoutLogPath,
    stderrLogPath,
    terminalLogPath,
    lastError,
    exitCode: lastExitCode,
    updatedAt: Date.now(),
  };

  writeJsonFile(workerStatePath, state);
}

function getTerminalHandle(): string | null {
  if (terminalBackend === 'tmux') return tmuxSessionName;
  return ptyProcess ? String(ptyProcess.pid) : null;
}

function getClaudePid(): number | null {
  if (terminalBackend === 'tmux') return getSessionPid(tmuxSessionName);
  return ptyProcess ? ptyProcess.pid : null;
}

async function handleRuntimeExit(exitCode?: number | null): Promise<void> {
  if (shuttingDown) return;
  if (typeof exitCode === 'number') {
    lastExitCode = exitCode;
  }
  if (!ready && !lastError) {
    recordFailure('Claude runtime exited before reaching the ready prompt.', lastExitCode);
  }
  workerStatus = 'exited';
  ready = false;
  await heartbeat();
  await shutdown('runtime-exit');
}

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Worker ${workerId} shutting down: ${reason}`);

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (tmuxPollTimer) clearInterval(tmuxPollTimer);

  if (terminalBackend === 'tmux') {
    if (tmuxSessionExists(tmuxSessionName)) {
      killTmuxSession(tmuxSessionName);
    }
  } else if (ptyProcess) {
    try {
      ptyProcess.kill();
    } catch {
      // best effort
    }
  }

  workerStatus = reason === 'terminate-request' ? 'stopped' : workerStatus;
  writeStateFile();
  await heartbeat();
  terminalLogStream?.end();
  process.exit(0);
}

function authorize(req: IncomingMessage): boolean {
  return req.headers.authorization === `Bearer ${workerToken}`;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  return raw ? JSON.parse(raw) : {};
}

function respondJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function shellEscapeCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellEscape).join(' ');
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function appendTerminalLog(chunk: string): void {
  if (!chunk || !terminalLogStream) return;
  terminalLogStream.write(chunk);
}

function recordFailure(message: string, exitCode: number | null): void {
  lastError = message;
  lastExitCode = exitCode;
  workerStatus = 'exited';
  ready = false;
  writeStateFile();
}

main().catch(async (err) => {
  const message = err instanceof Error ? err.message : String(err);
  recordFailure(message, lastExitCode);
  logger.error(`Worker fatal error: ${message}`);
  await heartbeat();
  terminalLogStream?.end();
  process.exit(1);
});

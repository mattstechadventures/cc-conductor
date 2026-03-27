import fs from 'fs';
import path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { extractCodexThreadId, shouldUseShellForExecutable } from './codex-cli.js';
import { logger } from './logger.js';
import { writeJsonFile } from './state.js';
import type {
  AgentBackend,
  WorkerHeartbeat,
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
const stdoutLogPath = process.env.CONDUCTOR_WORKER_STDOUT_LOG_PATH || path.join(workerStateDir, 'worker.stdout.log');
const stderrLogPath = process.env.CONDUCTOR_WORKER_STDERR_LOG_PATH || path.join(workerStateDir, 'worker.stderr.log');
const terminalLogPath = process.env.CONDUCTOR_TERMINAL_LOG_PATH || path.join(workerStateDir, 'terminal.log');
const runtimeBuildId = requiredEnv('CONDUCTOR_RUNTIME_BUILD_ID');
const codexSessionName = process.env.CONDUCTOR_CODEX_SESSION_NAME || sessionName;
const codexBin = process.env.CONDUCTOR_RESOLVED_CODEX_BIN || process.env.CODEX_BIN || 'codex';
const activeBackend = (process.env.CONDUCTOR_ACTIVE_BACKEND as AgentBackend | undefined) || 'codex';

let workerStatus: WorkerStatus = 'starting';
let ready = false;
let shuttingDown = false;
let serverPort = 0;
let currentTurn: Promise<TurnResult> | null = null;
let activeChild: ChildProcessWithoutNullStreams | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let terminalLogStream: fs.WriteStream | null = null;
let lastError: string | null = null;
let lastExitCode: number | null = null;
let currentResumeRef = process.env.CONDUCTOR_CODEX_RESUME_REF || '';

interface TurnResult {
  ok: boolean;
  error?: string;
}

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
          activeBackend,
          claudePid: getActiveChildPid(),
        });
        return;
      }

      if (req.method === 'POST' && req.url === '/input') {
        const body = await readJsonBody(req) as { message?: string };
        if (!body.message) {
          respondJson(res, 400, { ok: false, error: 'message is required' });
          return;
        }

        if (currentTurn) {
          respondJson(res, 409, { ok: false, error: 'A turn is already running' });
          return;
        }

        currentTurn = runCodexTurn(body.message);
        const result = await currentTurn;
        currentTurn = null;

        if (result.ok) {
          respondJson(res, 200, { ok: true });
        } else {
          respondJson(res, 500, { ok: false, error: result.error || 'Codex turn failed' });
        }
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
  workerStatus = 'ready';
  ready = true;
  writeStateFile();
  await heartbeat();
  startHeartbeat();

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM').catch(err => logger.error(`Codex worker shutdown failed: ${err.message}`));
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT').catch(err => logger.error(`Codex worker shutdown failed: ${err.message}`));
  });
}

async function runCodexTurn(message: string): Promise<TurnResult> {
  const outputLastMessagePath = path.join(workerStateDir, 'codex.last-message.txt');
  const args = buildCodexArgs(outputLastMessagePath);
  let stdout = '';
  let stderr = '';
  lastError = null;
  lastExitCode = null;

  return await new Promise<TurnResult>((resolve) => {
    let settled = false;
    const child = spawn(codexBin, args, {
      cwd: projectDir,
      env: process.env,
      shell: shouldUseShellForExecutable(codexBin),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    activeChild = child;
    writeStateFile();
    void heartbeat();

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf-8');
      stdout += text;
      appendTerminalLog(text);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf-8');
      stderr += text;
      appendTerminalLog(text);
    });

    child.on('error', async (err) => {
      if (settled) return;
      settled = true;
      const messageText = `Codex turn failed to start: ${err.message}`;
      lastError = messageText;
      logger.error(`Codex worker ${workerId} turn failed to start: ${err.message}`);
      activeChild = null;
      writeStateFile();
      await heartbeat();
      await postWorkerNotice(messageText);
      resolve({ ok: false, error: messageText });
    });

    child.on('close', async (exitCode) => {
      if (settled) return;
      settled = true;
      activeChild = null;
      lastExitCode = typeof exitCode === 'number' ? exitCode : null;
      writeStateFile();

      const threadId = extractCodexThreadId(stdout);
      if (threadId) {
        await syncCodexBackend(threadId);
      }

      const finalMessage = readOptionalText(outputLastMessagePath)?.trim();
      const success = exitCode === 0;
      if (success && finalMessage) {
        logger.info(`Codex worker ${workerId} turn completed successfully`);
        await postWorkerNotice(finalMessage);
        await heartbeat();
        resolve({ ok: true });
        return;
      }

      if (success) {
        const messageText = 'Codex turn completed without a final message.';
        lastError = messageText;
        logger.warn(`Codex worker ${workerId} completed without a final message`);
        await postWorkerNotice(messageText);
        await heartbeat();
        resolve({ ok: false, error: messageText });
        return;
      } else if (!success) {
        const errorText = buildFailureMessage(exitCode, stderr, stdout);
        lastError = errorText;
        logger.warn(`Codex worker ${workerId} turn failed: ${errorText}`);
        await postWorkerNotice(errorText);
      }

      await heartbeat();
      resolve({ ok: false, error: lastError || 'Codex turn failed' });
    });

    child.stdin.write(message);
    child.stdin.end();
  });
}

function buildCodexArgs(outputLastMessagePath: string): string[] {
  const base = currentResumeRef
    ? ['exec', 'resume', currentResumeRef, '-']
    : ['exec', '-'];

  for (const directory of additionalDirs) {
    base.push('--add-dir', directory);
  }

  base.push(
    '--skip-git-repo-check',
    '--json',
    '--output-last-message',
    outputLastMessagePath
  );

  return base;
}

async function registerWithDaemon(): Promise<void> {
  const registration: WorkerRegistration = {
    workerId,
    runtimeBuildId,
    port: serverPort,
    pid: process.pid,
    claudePid: getActiveChildPid(),
    activeBackend,
    terminalHandle: null,
    terminalBackend: 'none',
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
  const payload: WorkerHeartbeat = {
    workerId,
    runtimeBuildId,
    port: serverPort,
    pid: process.pid,
    claudePid: getActiveChildPid(),
    activeBackend,
    terminalHandle: null,
    terminalBackend: 'none',
    workerStatus,
  };

  writeStateFile();
  await fetch(`${daemonUrl}/internal/sessions/${sessionId}/worker/heartbeat`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${workerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

async function syncCodexBackend(threadId: string): Promise<void> {
  currentResumeRef = threadId;
  await fetch(`${daemonUrl}/internal/sessions/${sessionId}/worker/backend-state`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${workerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      backend: 'codex',
      nativeSessionName: codexSessionName,
      nativeResumeRef: threadId,
      state: 'active',
      lastActiveAt: Date.now(),
    }),
  }).catch(() => {});
}

async function postWorkerNotice(message: string): Promise<void> {
  await fetch(`${daemonUrl}/internal/sessions/${sessionId}/worker/notice`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${workerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message }),
  }).catch(() => {});
}

function writeStateFile(): void {
  const state: WorkerStateFile = {
    sessionId,
    workerId,
    runtimeBuildId,
    port: serverPort || null,
    pid: process.pid,
    claudePid: getActiveChildPid(),
    activeBackend,
    terminalBackend: 'none',
    terminalHandle: null,
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

function getActiveChildPid(): number | null {
  return activeChild?.pid ?? null;
}

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Codex worker ${workerId} shutting down: ${reason}`);

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }

  if (activeChild) {
    try {
      activeChild.kill();
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

function appendTerminalLog(chunk: string): void {
  if (!chunk || !terminalLogStream) return;
  terminalLogStream.write(chunk);
}

function buildFailureMessage(exitCode: number | null, stderr: string, stdout: string): string {
  const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
  const compact = detail.length > 1200 ? `${detail.slice(0, 1197)}...` : detail;
  if (compact) {
    return `Codex turn failed${exitCode !== null ? ` (exit ${exitCode})` : ''}:\n${compact}`;
  }
  return `Codex turn failed${exitCode !== null ? ` (exit ${exitCode})` : ''}.`;
}

function readOptionalText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

main().catch((err) => {
  logger.error(`Codex worker fatal error: ${err.message}`);
  process.exit(1);
});

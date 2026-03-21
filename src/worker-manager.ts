import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { nanoid } from 'nanoid';
import { registerSessionChannelServer, unregisterSessionChannelServer } from './claude-mcp.js';
import { getSessionBackend, getSessionInternalAuth, setSessionInternalAuth, updateSessionRuntime } from './sessions.js';
import { waitForWorkerStatus } from './runtime-state.js';
import {
  getRepoRoot,
  getWorkerStatePath,
  getWorkerStdoutLogPath,
  getWorkerStderrLogPath,
  getWorkerTerminalLogPath,
  writeJsonFile,
} from './state.js';
import { logger } from './logger.js';
import type { Session, WorkerLaunchMode, WorkerStartResult, WorkerStateFile } from './types.js';
import { buildWorkerStartupFailure } from './worker-diagnostics.js';

const WORKER_READY_TIMEOUT_MS = 30_000;

export async function spawnSessionWorker(
  session: Session,
  options: {
    mode: WorkerLaunchMode;
    resumePromptPath?: string | null;
  }
): Promise<WorkerStartResult> {
  const workerId = nanoid(12);
  const workerToken = nanoid(32);
  const channelToken = nanoid(32);
  const daemonUrl = `http://127.0.0.1:${process.env.CONDUCTOR_API_PORT || '7842'}`;
  const structuredTransport = session.activeBackend === 'claude' && process.env.STRUCTURED_TRANSPORT !== 'off';
  const workerStatePath = getWorkerStatePath(session.id);
  const stdoutLogPath = getWorkerStdoutLogPath(session.id);
  const stderrLogPath = getWorkerStderrLogPath(session.id);
  const terminalLogPath = getWorkerTerminalLogPath(session.id);
  const terminalBackend = session.activeBackend === 'claude'
    ? (process.env.TERMINAL_BACKEND === 'tmux' ? 'tmux' : 'pty')
    : 'none';
  const claudeBackend = getSessionBackend(session.id, 'claude');
  const codexBackend = getSessionBackend(session.id, 'codex');
  const workerEntry = session.activeBackend === 'claude'
    ? `${getRepoRoot()}/src/worker.ts`
    : `${getRepoRoot()}/src/codex-worker.ts`;

  setSessionInternalAuth(session.id, {
    workerToken,
    channelToken,
  });

  updateSessionRuntime(session.id, {
    workerId,
    terminalBackend,
    terminalHandle: session.activeBackend === 'claude' ? session.terminalHandle : null,
    transportKind: session.activeBackend === 'codex'
      ? 'worker_http'
      : (structuredTransport ? 'channel' : 'pty_fallback'),
    transportState: 'disconnected',
    claudeSessionName: claudeBackend?.nativeSessionName || session.claudeSessionName,
    claudeResumeRef: claudeBackend?.nativeResumeRef || session.claudeResumeRef || session.claudeSessionName,
    workerStatus: 'starting',
    pid: null,
  });

  writeJsonFile(workerStatePath, {
    sessionId: session.id,
    workerId,
    port: null,
    pid: null,
    claudePid: null,
    activeBackend: session.activeBackend,
    terminalBackend,
    terminalHandle: null,
    workerStatus: 'starting',
    ready: false,
    updatedAt: Date.now(),
    stdoutLogPath,
    stderrLogPath,
    terminalLogPath,
    lastError: null,
    exitCode: null,
  } satisfies WorkerStateFile);

  appendLaunchMarker(stdoutLogPath, workerId, options.mode);
  appendLaunchMarker(stderrLogPath, workerId, options.mode);
  appendLaunchMarker(terminalLogPath, workerId, options.mode);

  if (structuredTransport) {
    try {
      registerSessionChannelServer(session, {
        daemonUrl,
        channelToken,
        resumePromptPath: options.resumePromptPath || '',
      });
    } catch (err: any) {
      writeLaunchFailureState({
        sessionId: session.id,
        workerId,
        activeBackend: session.activeBackend,
        workerStatePath,
        stdoutLogPath,
        stderrLogPath,
        terminalLogPath,
        terminalBackend,
        error: err.message,
      });
      return buildWorkerStartupFailure(session.id, `Worker for session ${session.name} failed to start`);
    }
  }

  let child: ReturnType<typeof spawn>;
  let stdoutFd: number | null = null;
  let stderrFd: number | null = null;
  try {
    stdoutFd = fs.openSync(stdoutLogPath, 'a');
    stderrFd = fs.openSync(stderrLogPath, 'a');
    child = spawn(
      process.execPath,
      ['--import', 'tsx', workerEntry],
      {
        cwd: getRepoRoot(),
        detached: true,
        stdio: ['ignore', stdoutFd, stderrFd],
        windowsHide: true,
        env: {
          ...process.env,
          CONDUCTOR_SESSION_ID: session.id,
          CONDUCTOR_WORKER_ID: workerId,
          CONDUCTOR_WORKER_TOKEN: workerToken,
          CONDUCTOR_CHANNEL_TOKEN: channelToken,
          CONDUCTOR_DAEMON_URL: daemonUrl,
          CONDUCTOR_WORKER_STATE_PATH: workerStatePath,
          CONDUCTOR_WORKER_STDOUT_LOG_PATH: stdoutLogPath,
          CONDUCTOR_WORKER_STDERR_LOG_PATH: stderrLogPath,
          CONDUCTOR_TERMINAL_LOG_PATH: terminalLogPath,
          CONDUCTOR_WORKER_MODE: options.mode,
          CONDUCTOR_STRUCTURED_TRANSPORT: structuredTransport ? 'channel' : 'off',
          CONDUCTOR_RESUME_PROMPT_PATH: options.resumePromptPath || '',
          CONDUCTOR_SESSION_NAME: session.name,
          CONDUCTOR_PROJECT_DIR: session.projectDir,
          CONDUCTOR_ADDITIONAL_DIRS_JSON: JSON.stringify(session.additionalDirs),
          CONDUCTOR_ACTIVE_BACKEND: session.activeBackend,
          CONDUCTOR_CLAUDE_SESSION_NAME: claudeBackend?.nativeSessionName || session.claudeSessionName,
          CONDUCTOR_CLAUDE_RESUME_REF: claudeBackend?.nativeResumeRef || session.claudeResumeRef || session.claudeSessionName,
          CONDUCTOR_CODEX_SESSION_NAME: codexBackend?.nativeSessionName || session.name,
          CONDUCTOR_CODEX_RESUME_REF: codexBackend?.nativeResumeRef || '',
          CONDUCTOR_TERMINAL_BACKEND: terminalBackend,
        },
      }
    );
  } catch (err: any) {
    writeLaunchFailureState({
      sessionId: session.id,
      workerId,
      activeBackend: session.activeBackend,
      workerStatePath,
      stdoutLogPath,
      stderrLogPath,
      terminalLogPath,
      terminalBackend,
      error: `Failed to spawn detached worker: ${err.message}`,
    });
    cleanupRegisteredChannelServer(session, structuredTransport);
    return buildWorkerStartupFailure(session.id, `Worker for session ${session.name} failed to start`);
  } finally {
    if (stdoutFd !== null) fs.closeSync(stdoutFd);
    if (stderrFd !== null) fs.closeSync(stderrFd);
  }

  child.unref();
  logger.info(`Spawned detached worker ${workerId} for session ${session.name}`);

  const ready = await waitForWorkerStatus(session.id, ['ready'], WORKER_READY_TIMEOUT_MS);
  if (ready) {
    return {
      ready: true,
      stdoutLogPath,
      stderrLogPath,
      terminalLogPath,
    };
  }

  return buildWorkerStartupFailure(
    session.id,
    `Worker for session ${session.name} did not become ready within ${WORKER_READY_TIMEOUT_MS / 1000}s`
  );
}

export async function sendInputToWorker(session: Session, message: string): Promise<boolean> {
  const auth = getSessionInternalAuth(session.id);
  const port = await readWorkerPort(session.id);
  if (!auth?.workerToken || !port) return false;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/input`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${auth.workerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function terminateSessionWorker(session: Session): Promise<void> {
  const auth = getSessionInternalAuth(session.id);
  const port = await readWorkerPort(session.id);
  if (!auth?.workerToken || !port) {
    clearStaleWorkerRuntime(session.id);
    cleanupRegisteredChannelServer(session, session.transportKind === 'channel');
    return;
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/control/terminate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${auth.workerToken}`,
      },
    });
    if (!res.ok) {
      clearStaleWorkerRuntime(session.id);
      logger.warn(`Failed to terminate worker for ${session.name}: HTTP ${res.status}`);
    }
  } catch (err: any) {
    clearStaleWorkerRuntime(session.id);
    logger.warn(`Failed to terminate worker for ${session.name}: ${err.message}`);
  }

  cleanupRegisteredChannelServer(session, session.transportKind === 'channel');
}

async function readWorkerPort(sessionId: string): Promise<number | null> {
  const workerStatePath = getWorkerStatePath(sessionId);
  try {
    const raw = JSON.parse(await (await import('fs/promises')).readFile(workerStatePath, 'utf-8')) as {
      port?: number;
    };
    return typeof raw.port === 'number' ? raw.port : null;
  } catch {
    return null;
  }
}

function appendLaunchMarker(logPath: string, workerId: string, mode: WorkerLaunchMode): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `\n=== worker ${workerId} launch (${mode}) ${new Date().toISOString()} ===\n`);
}

function clearStaleWorkerRuntime(sessionId: string): void {
  updateSessionRuntime(sessionId, {
    workerId: null,
    terminalHandle: null,
    transportState: 'disconnected',
    workerStatus: 'stopped',
    pid: null,
  });
}

function writeLaunchFailureState(input: {
  sessionId: string;
  workerId: string;
  activeBackend: Session['activeBackend'];
  workerStatePath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  terminalLogPath: string;
  terminalBackend: Session['terminalBackend'];
  error: string;
}): void {
  const state: WorkerStateFile = {
    sessionId: input.sessionId,
    workerId: input.workerId,
    port: null,
    pid: null,
    claudePid: null,
    activeBackend: input.activeBackend,
    terminalBackend: input.terminalBackend,
    terminalHandle: null,
    workerStatus: 'exited',
    ready: false,
    updatedAt: Date.now(),
    stdoutLogPath: input.stdoutLogPath,
    stderrLogPath: input.stderrLogPath,
    terminalLogPath: input.terminalLogPath,
    lastError: input.error,
    exitCode: null,
  };

  fs.appendFileSync(input.stderrLogPath, `${input.error}\n`);
  writeJsonFile(input.workerStatePath, state);
}

function cleanupRegisteredChannelServer(session: Session, structuredTransport: boolean): void {
  if (!structuredTransport) return;
  try {
    unregisterSessionChannelServer(session, { ignoreMissing: true });
  } catch (err: any) {
    logger.warn(`Failed to remove Claude MCP server for ${session.name}: ${err.message}`);
  }
}

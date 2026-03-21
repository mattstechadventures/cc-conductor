import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { nanoid } from 'nanoid';
import { registerSessionChannelServer, unregisterSessionChannelServer } from './claude-mcp.js';
import { getSessionBackend, getSessionInternalAuth, setSessionInternalAuth, updateSessionRuntime } from './sessions.js';
import { clearWorkerRuntime, waitForWorkerStatus } from './runtime-state.js';
import { getRuntimeBuildId } from './runtime-build.js';
import {
  getRepoRoot,
  getWorkerStatePath,
  getWorkerStdoutLogPath,
  getWorkerStderrLogPath,
  getWorkerTerminalLogPath,
  writeJsonFile,
} from './state.js';
import { logger } from './logger.js';
import { readWorkerControlState, requestWorkerTerminate, terminateWorkerProcess } from './worker-control.js';
import type { Session, WorkerLaunchMode, WorkerStartResult, WorkerStateFile } from './types.js';
import { buildWorkerStartupFailure } from './worker-diagnostics.js';

const WORKER_READY_TIMEOUT_MS = 30_000;
const runtimeBuildId = process.env.CONDUCTOR_RUNTIME_BUILD_ID || getRuntimeBuildId();

export interface WorkerInputResult {
  ok: boolean;
  error?: string;
}

export interface WorkerLaunchPlanInput {
  session: Session;
  options: {
    mode: WorkerLaunchMode;
    resumePromptPath?: string | null;
  };
  claudeBackend?: ReturnType<typeof getSessionBackend> | null;
  codexBackend?: ReturnType<typeof getSessionBackend> | null;
  workerId: string;
  workerToken: string;
  channelToken: string;
  runtimeBuildId?: string;
}

export interface WorkerLaunchPlan {
  workerId: string;
  workerToken: string;
  channelToken: string;
  runtimeBuildId: string;
  daemonUrl: string;
  structuredTransport: boolean;
  workerStatePath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
  terminalLogPath: string;
  terminalBackend: Session['terminalBackend'];
  workerEntry: string;
  workerState: WorkerStateFile;
  launchEnv: NodeJS.ProcessEnv;
}

export function buildWorkerLaunchPlan(input: WorkerLaunchPlanInput): WorkerLaunchPlan {
  const runtimeBuildId = input.runtimeBuildId || process.env.CONDUCTOR_RUNTIME_BUILD_ID || getRuntimeBuildId();
  const daemonUrl = `http://127.0.0.1:${process.env.CONDUCTOR_API_PORT || '7842'}`;
  const structuredTransport = input.session.activeBackend === 'claude' && process.env.STRUCTURED_TRANSPORT !== 'off';
  const workerStatePath = getWorkerStatePath(input.session.id);
  const stdoutLogPath = getWorkerStdoutLogPath(input.session.id);
  const stderrLogPath = getWorkerStderrLogPath(input.session.id);
  const terminalLogPath = getWorkerTerminalLogPath(input.session.id);
  const terminalBackend = input.session.activeBackend === 'claude'
    ? (process.env.TERMINAL_BACKEND === 'tmux' ? 'tmux' : 'pty')
    : 'none';
  const workerEntry = input.session.activeBackend === 'claude'
    ? `${getRepoRoot()}/src/worker.ts`
    : `${getRepoRoot()}/src/codex-worker.ts`;

  const launchEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CONDUCTOR_SESSION_ID: input.session.id,
    CONDUCTOR_WORKER_ID: input.workerId,
    CONDUCTOR_WORKER_TOKEN: input.workerToken,
    CONDUCTOR_CHANNEL_TOKEN: input.channelToken,
    CONDUCTOR_DAEMON_URL: daemonUrl,
    CONDUCTOR_WORKER_STATE_PATH: workerStatePath,
    CONDUCTOR_WORKER_STDOUT_LOG_PATH: stdoutLogPath,
    CONDUCTOR_WORKER_STDERR_LOG_PATH: stderrLogPath,
    CONDUCTOR_TERMINAL_LOG_PATH: terminalLogPath,
    CONDUCTOR_WORKER_MODE: input.options.mode,
    CONDUCTOR_STRUCTURED_TRANSPORT: structuredTransport ? 'channel' : 'off',
    CONDUCTOR_RESUME_PROMPT_PATH: input.options.resumePromptPath || '',
    CONDUCTOR_SESSION_NAME: input.session.name,
    CONDUCTOR_PROJECT_DIR: input.session.projectDir,
    CONDUCTOR_ADDITIONAL_DIRS_JSON: JSON.stringify(input.session.additionalDirs),
    CONDUCTOR_ACTIVE_BACKEND: input.session.activeBackend,
    CONDUCTOR_CLAUDE_SESSION_NAME: input.claudeBackend?.nativeSessionName || input.session.claudeSessionName,
    CONDUCTOR_CLAUDE_RESUME_REF: input.claudeBackend?.nativeResumeRef || input.session.claudeResumeRef || input.session.claudeSessionName,
    CONDUCTOR_CODEX_SESSION_NAME: input.codexBackend?.nativeSessionName || input.session.name,
    CONDUCTOR_CODEX_RESUME_REF: input.codexBackend?.nativeResumeRef || '',
    CONDUCTOR_TERMINAL_BACKEND: terminalBackend,
    CONDUCTOR_RUNTIME_BUILD_ID: runtimeBuildId,
  };

  return {
    workerId: input.workerId,
    workerToken: input.workerToken,
    channelToken: input.channelToken,
    runtimeBuildId,
    daemonUrl,
    structuredTransport,
    workerStatePath,
    stdoutLogPath,
    stderrLogPath,
    terminalLogPath,
    terminalBackend,
    workerEntry,
    workerState: {
      sessionId: input.session.id,
      workerId: input.workerId,
      runtimeBuildId,
      port: null,
      pid: null,
      claudePid: null,
      activeBackend: input.session.activeBackend,
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
    },
    launchEnv,
  };
}

export interface WorkerInputContext {
  auth: ReturnType<typeof getSessionInternalAuth>;
  controlState: ReturnType<typeof readWorkerControlState>;
  fetchImpl?: typeof fetch;
}

export async function sendInputToWorkerWithContext(
  message: string,
  context: WorkerInputContext
): Promise<WorkerInputResult> {
  if (!context.auth?.workerToken || !context.controlState.port) {
    return { ok: false, error: 'No worker transport is available.' };
  }

  try {
    const res = await (context.fetchImpl || fetch)(`http://127.0.0.1:${context.controlState.port}/input`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${context.auth.workerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
    });
    if (res.ok) {
      return { ok: true };
    }

    let payload: { error?: string } | null = null;
    try {
      payload = await res.json() as { error?: string };
    } catch {
      payload = null;
    }

    return {
      ok: false,
      error: buildWorkerInputFailure(res.status, payload),
    };
  } catch (err: any) {
    return {
      ok: false,
      error: `Worker input request failed: ${err.message}`,
    };
  }
}

export interface WorkerTerminationContext {
  auth: ReturnType<typeof getSessionInternalAuth>;
  controlState: ReturnType<typeof readWorkerControlState>;
  requestTerminate?: typeof requestWorkerTerminate;
  terminateProcess?: typeof terminateWorkerProcess;
  clearRuntime?: (sessionId: string) => void;
  cleanupRegisteredChannelServer?: (session: Session, structuredTransport: boolean) => void;
  logger?: Pick<typeof logger, 'warn'>;
}

export async function terminateSessionWorkerWithContext(
  session: Session,
  context: WorkerTerminationContext
): Promise<void> {
  let terminateError: string | null = null;

  if (context.auth?.workerToken && context.controlState.port) {
    const terminate = context.requestTerminate || requestWorkerTerminate;
    const result = await terminate(context.controlState.port, context.auth.workerToken);
    if (!result.ok) {
      terminateError = result.error || 'unknown error';
    }
  }

  if (terminateError || !context.auth?.workerToken || !context.controlState.port) {
    const terminateProcess = context.terminateProcess || terminateWorkerProcess;
    const pidResult = terminateProcess(context.controlState.pid);
    if (!pidResult.ok && terminateError) {
      (context.logger || logger).warn(`Failed to terminate worker for ${session.name}: ${terminateError}`);
    } else if (!pidResult.ok && !terminateError && context.controlState.pid) {
      (context.logger || logger).warn(`Failed to terminate worker for ${session.name}: ${pidResult.error}`);
    }
  }

  if (context.clearRuntime) {
    context.clearRuntime(session.id);
  }
  if (context.cleanupRegisteredChannelServer) {
    context.cleanupRegisteredChannelServer(session, session.transportKind === 'channel');
  }
}

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
  const claudeBackend = getSessionBackend(session.id, 'claude');
  const codexBackend = getSessionBackend(session.id, 'codex');
  const plan = buildWorkerLaunchPlan({
    session,
    options,
    claudeBackend,
    codexBackend,
    workerId,
    workerToken,
    channelToken,
    runtimeBuildId,
  });

  setSessionInternalAuth(session.id, {
    workerToken: plan.workerToken,
    channelToken: plan.channelToken,
  });

  updateSessionRuntime(session.id, {
    workerId: plan.workerId,
    terminalBackend: plan.terminalBackend,
    terminalHandle: session.activeBackend === 'claude' ? session.terminalHandle : null,
    transportKind: session.activeBackend === 'codex'
      ? 'worker_http'
      : (plan.structuredTransport ? 'channel' : 'pty_fallback'),
    transportState: 'disconnected',
    claudeSessionName: claudeBackend?.nativeSessionName || session.claudeSessionName,
    claudeResumeRef: claudeBackend?.nativeResumeRef || session.claudeResumeRef || session.claudeSessionName,
    workerStatus: 'starting',
    pid: null,
  });

  writeJsonFile(plan.workerStatePath, plan.workerState);

  appendLaunchMarker(plan.stdoutLogPath, plan.workerId, options.mode);
  appendLaunchMarker(plan.stderrLogPath, plan.workerId, options.mode);
  appendLaunchMarker(plan.terminalLogPath, plan.workerId, options.mode);

  if (plan.structuredTransport) {
    try {
      registerSessionChannelServer(session, {
        daemonUrl: plan.daemonUrl,
        channelToken: plan.channelToken,
        resumePromptPath: options.resumePromptPath || '',
      });
    } catch (err: any) {
      writeLaunchFailureState({
        sessionId: session.id,
        workerId: plan.workerId,
        activeBackend: session.activeBackend,
        workerStatePath: plan.workerStatePath,
        stdoutLogPath: plan.stdoutLogPath,
        stderrLogPath: plan.stderrLogPath,
        terminalLogPath: plan.terminalLogPath,
        terminalBackend: plan.terminalBackend,
        error: err.message,
      });
      return buildWorkerStartupFailure(session.id, `Worker for session ${session.name} failed to start`);
    }
  }

  let child: ReturnType<typeof spawn>;
  let stdoutFd: number | null = null;
  let stderrFd: number | null = null;
  try {
    stdoutFd = fs.openSync(plan.stdoutLogPath, 'a');
    stderrFd = fs.openSync(plan.stderrLogPath, 'a');
    child = spawn(
      process.execPath,
      ['--import', 'tsx', plan.workerEntry],
      {
        cwd: getRepoRoot(),
        detached: true,
        stdio: ['ignore', stdoutFd, stderrFd],
        windowsHide: true,
        env: plan.launchEnv,
      }
    );
  } catch (err: any) {
    writeLaunchFailureState({
      sessionId: session.id,
      workerId: plan.workerId,
      activeBackend: session.activeBackend,
      workerStatePath: plan.workerStatePath,
      stdoutLogPath: plan.stdoutLogPath,
      stderrLogPath: plan.stderrLogPath,
      terminalLogPath: plan.terminalLogPath,
      terminalBackend: plan.terminalBackend,
      error: `Failed to spawn detached worker: ${err.message}`,
    });
    cleanupRegisteredChannelServer(session, plan.structuredTransport);
    return buildWorkerStartupFailure(session.id, `Worker for session ${session.name} failed to start`);
  } finally {
    if (stdoutFd !== null) fs.closeSync(stdoutFd);
    if (stderrFd !== null) fs.closeSync(stderrFd);
  }

  child.unref();
  logger.info(`Spawned detached worker ${plan.workerId} for session ${session.name}`);

  const ready = await waitForWorkerStatus(session.id, ['ready'], WORKER_READY_TIMEOUT_MS);
  if (ready) {
    return {
      ready: true,
      stdoutLogPath: plan.stdoutLogPath,
      stderrLogPath: plan.stderrLogPath,
      terminalLogPath: plan.terminalLogPath,
    };
  }

  return buildWorkerStartupFailure(
    session.id,
    `Worker for session ${session.name} did not become ready within ${WORKER_READY_TIMEOUT_MS / 1000}s`
  );
}

export async function sendInputToWorker(session: Session, message: string): Promise<WorkerInputResult> {
  const auth = getSessionInternalAuth(session.id);
  const controlState = readWorkerControlState(session.id);
  return await sendInputToWorkerWithContext(message, { auth, controlState });
}

export function buildWorkerInputFailure(
  statusCode: number,
  payload?: { error?: string } | null
): string {
  if (payload?.error) {
    return payload.error;
  }
  return `Worker input request failed with HTTP ${statusCode}.`;
}

export async function terminateSessionWorker(session: Session): Promise<void> {
  const auth = getSessionInternalAuth(session.id);
  const controlState = readWorkerControlState(session.id);
  await terminateSessionWorkerWithContext(session, {
    auth,
    controlState,
    requestTerminate: requestWorkerTerminate,
    terminateProcess: terminateWorkerProcess,
    clearRuntime: clearStaleWorkerRuntime,
    cleanupRegisteredChannelServer,
    logger,
  });
}

function appendLaunchMarker(logPath: string, workerId: string, mode: WorkerLaunchMode): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `\n=== worker ${workerId} launch (${mode}) ${new Date().toISOString()} ===\n`);
}

function clearStaleWorkerRuntime(sessionId: string): void {
  clearWorkerRuntime(sessionId);
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
    runtimeBuildId,
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

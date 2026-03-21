import type { WorkerStartResult, WorkerStateFile } from './types.js';
import {
  getWorkerStatePath,
  getWorkerStderrLogPath,
  getWorkerStdoutLogPath,
  getWorkerTerminalLogPath,
  readJsonFile,
  readTextFileTail,
  toRepoRelativePath,
} from './state.js';

const MAX_FAILURE_DETAIL_CHARS = 900;

export function readWorkerState(sessionId: string): WorkerStateFile | null {
  return readJsonFile<WorkerStateFile>(getWorkerStatePath(sessionId));
}

export function buildWorkerStartupFailure(
  sessionId: string,
  fallbackMessage: string
): WorkerStartResult {
  const state = readWorkerState(sessionId);
  const stdoutLogPath = state?.stdoutLogPath || getWorkerStdoutLogPath(sessionId);
  const stderrLogPath = state?.stderrLogPath || getWorkerStderrLogPath(sessionId);
  const terminalLogPath = state?.terminalLogPath || getWorkerTerminalLogPath(sessionId);
  const lastError = state?.lastError?.trim();
  const terminalTail = normalizeTail(readTextFileTail(terminalLogPath));
  const stderrTail = normalizeTail(readTextFileTail(stderrLogPath));
  const stdoutTail = normalizeTail(readTextFileTail(stdoutLogPath));
  const exitCode = state?.exitCode;

  const detail = truncateForDisplay(lastError || terminalTail || stderrTail || stdoutTail, MAX_FAILURE_DETAIL_CHARS);
  const exitSuffix = typeof exitCode === 'number' ? ` Exit code: ${exitCode}.` : '';
  const logs = [
    toRepoRelativePath(stdoutLogPath),
    toRepoRelativePath(stderrLogPath),
    toRepoRelativePath(terminalLogPath),
  ];
  const error = detail
    ? `${fallbackMessage}: ${detail}.${exitSuffix} See ${logs.join(', ')}.`
    : `${fallbackMessage}.${exitSuffix} See ${logs.join(', ')}.`;

  return {
    ready: false,
    error,
    stdoutLogPath,
    stderrLogPath,
    terminalLogPath,
  };
}

function normalizeTail(text: string | null): string | null {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function truncateForDisplay(text: string | null, maxChars: number): string | null {
  if (!text || text.length <= maxChars) return text;
  const head = Math.floor((maxChars - 3) / 2);
  const tail = maxChars - 3 - head;
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

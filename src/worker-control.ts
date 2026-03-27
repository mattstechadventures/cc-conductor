import { getWorkerStatePath, readJsonFile } from './state.js';
import type { WorkerStateFile } from './types.js';

export interface WorkerControlState {
  port: number | null;
  pid: number | null;
}

export function readWorkerControlState(sessionId: string): WorkerControlState {
  const state = readJsonFile<WorkerStateFile>(getWorkerStatePath(sessionId));
  return {
    port: typeof state?.port === 'number' ? state.port : null,
    pid: typeof state?.pid === 'number' ? state.pid : null,
  };
}

export async function requestWorkerTerminate(port: number, workerToken: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/control/terminate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${workerToken}`,
      },
    });
    if (res.ok) {
      return { ok: true };
    }
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export function terminateWorkerProcess(pid: number | null): { ok: boolean; alreadyExited: boolean; error?: string } {
  if (!Number.isFinite(pid) || !pid || pid <= 0) {
    return { ok: false, alreadyExited: false, error: 'No worker PID is available.' };
  }

  try {
    process.kill(pid);
    return { ok: true, alreadyExited: false };
  } catch (err: any) {
    if (err?.code === 'ESRCH') {
      return { ok: true, alreadyExited: true };
    }
    return { ok: false, alreadyExited: false, error: err.message };
  }
}

export function formatRuntimeBuildIdForLog(buildId: string | null | undefined): string {
  if (!buildId) return '<missing>';
  return buildId.length <= 12 ? buildId : `${buildId.slice(0, 12)}...`;
}

export function isDiscordMissingPermissionsError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  if (code === 50013 || code === '50013') {
    return true;
  }

  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && message.toLowerCase().includes('missing permissions');
}

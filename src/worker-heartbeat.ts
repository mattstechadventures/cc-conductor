import type { Session, WorkerHeartbeat } from './types.js';

export interface WorkerReadyTransition {
  notice: 'ready' | 'reconnected';
  runtimePatch: Partial<Pick<Session, 'transportKind' | 'transportState'>>;
  shouldMarkBackendActive: boolean;
}

export function getReadyHeartbeatTransition(
  session: Pick<Session, 'status' | 'activeBackend'>,
  payload: Pick<WorkerHeartbeat, 'activeBackend'>
): WorkerReadyTransition | null {
  if (session.status !== 'starting' && session.status !== 'interrupted') {
    return null;
  }

  return {
    notice: session.status === 'starting' ? 'ready' : 'reconnected',
    runtimePatch: payload.activeBackend === 'codex'
      ? {
          transportKind: 'worker_http',
          transportState: 'connected',
        }
      : {},
    shouldMarkBackendActive: session.activeBackend === payload.activeBackend,
  };
}

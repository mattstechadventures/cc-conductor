export type WorkerBuildCompatibilityIssue = 'missing-runtime-build-id' | 'runtime-build-mismatch';

export function getWorkerBuildCompatibilityIssue(
  expectedRuntimeBuildId: string,
  worker: { runtimeBuildId?: string | null }
): WorkerBuildCompatibilityIssue | null {
  if (!worker.runtimeBuildId) {
    return 'missing-runtime-build-id';
  }

  if (worker.runtimeBuildId !== expectedRuntimeBuildId) {
    return 'runtime-build-mismatch';
  }

  return null;
}

export function hasCompatibleWorkerRuntime(
  expectedRuntimeBuildId: string,
  worker: { runtimeBuildId?: string | null } | null | undefined
): boolean {
  if (!worker) {
    return false;
  }
  return getWorkerBuildCompatibilityIssue(expectedRuntimeBuildId, worker) === null;
}

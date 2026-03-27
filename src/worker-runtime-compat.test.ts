import test from 'node:test';
import assert from 'node:assert/strict';
import { getWorkerBuildCompatibilityIssue, hasCompatibleWorkerRuntime } from './worker-runtime-compat.js';

test('matching runtime build ids are accepted', () => {
  assert.equal(
    getWorkerBuildCompatibilityIssue('build-123', { runtimeBuildId: 'build-123' }),
    null
  );
  assert.equal(
    hasCompatibleWorkerRuntime('build-123', { runtimeBuildId: 'build-123' }),
    true
  );
});

test('missing runtime build ids are rejected as stale', () => {
  assert.equal(
    getWorkerBuildCompatibilityIssue('build-123', { runtimeBuildId: null }),
    'missing-runtime-build-id'
  );
  assert.equal(
    hasCompatibleWorkerRuntime('build-123', { runtimeBuildId: null }),
    false
  );
});

test('mismatched runtime build ids are rejected and not considered healthy for reconciliation', () => {
  assert.equal(
    getWorkerBuildCompatibilityIssue('build-123', { runtimeBuildId: 'build-999' }),
    'runtime-build-mismatch'
  );
  assert.equal(
    hasCompatibleWorkerRuntime('build-123', { runtimeBuildId: 'build-999' }),
    false
  );
});

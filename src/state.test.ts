import test from 'node:test';
import assert from 'node:assert/strict';
import { managedPathsEqual, normalizeManagedPath } from './state.js';

test('normalizeManagedPath trims redundant Windows separators', () => {
  assert.equal(normalizeManagedPath('D:\\repos\\\\', 'win32'), 'D:\\repos');
});

test('managedPathsEqual is case-insensitive on Windows', () => {
  assert.equal(managedPathsEqual('D:\\Repos', 'd:\\repos\\', 'win32'), true);
});

test('managedPathsEqual is case-sensitive on POSIX', () => {
  assert.equal(managedPathsEqual('/tmp/Repos', '/tmp/repos', 'linux'), false);
});

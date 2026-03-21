import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRuntimeBuildId, listRuntimeBuildPaths } from './runtime-build.js';

test('runtime build paths include package.json and non-test src files in sorted order', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-conductor-build-'));

  try {
    fs.mkdirSync(path.join(tempRoot, 'src', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'package.json'), '{"name":"test"}');
    fs.writeFileSync(path.join(tempRoot, 'src', 'z.ts'), 'export const z = 1;');
    fs.writeFileSync(path.join(tempRoot, 'src', 'a.ts'), 'export const a = 1;');
    fs.writeFileSync(path.join(tempRoot, 'src', 'a.test.ts'), 'test("ignored", () => {});');
    fs.writeFileSync(path.join(tempRoot, 'src', 'nested', 'b.ts'), 'export const b = 1;');

    assert.deepEqual(listRuntimeBuildPaths(tempRoot), [
      'package.json',
      'src/a.ts',
      'src/nested/b.ts',
      'src/z.ts',
    ]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('runtime build hashing is deterministic for the same file set', () => {
  const buildIdA = createRuntimeBuildId([
    { relativePath: 'src/z.ts', content: 'export const z = 1;' },
    { relativePath: 'package.json', content: '{"name":"test"}' },
    { relativePath: 'src/a.ts', content: 'export const a = 1;' },
  ]);
  const buildIdB = createRuntimeBuildId([
    { relativePath: 'src/a.ts', content: 'export const a = 1;' },
    { relativePath: 'src/z.ts', content: 'export const z = 1;' },
    { relativePath: 'package.json', content: '{"name":"test"}' },
  ]);

  assert.equal(buildIdA, buildIdB);
});

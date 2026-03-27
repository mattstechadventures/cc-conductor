import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  compareClaudeVersions,
  formatClaudeVersion,
  getMinimumClaudeVersion,
  parseClaudeVersion,
  resolveClaudeExecutable,
} from './claude-cli.js';

test('parseClaudeVersion extracts the semantic version from Claude output', () => {
  assert.deepEqual(parseClaudeVersion('2.1.80 (Claude Code)'), {
    major: 2,
    minor: 1,
    patch: 80,
  });
});

test('minimum supported Claude version is enforced through comparison helpers', () => {
  const minimum = getMinimumClaudeVersion();
  const lower = parseClaudeVersion('2.1.76 (Claude Code)');
  const exact = parseClaudeVersion('2.1.80 (Claude Code)');

  assert.ok(lower);
  assert.ok(exact);
  assert.equal(compareClaudeVersions(lower!, minimum) < 0, true);
  assert.equal(compareClaudeVersions(exact!, minimum), 0);
  assert.equal(formatClaudeVersion(minimum), '2.1.80');
});

test('resolveClaudeExecutable prefers Windows runnable shims over extensionless npm stubs', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-'));
  const stubBase = path.join(tempDir, 'claude');
  const cmdPath = `${stubBase}.cmd`;

  try {
    fs.writeFileSync(stubBase, '#!/bin/sh\necho raw stub\n');
    fs.writeFileSync(cmdPath, '@echo off\r\necho cmd shim\r\n');

    const resolved = resolveClaudeExecutable(stubBase, {
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    }, 'win32');

    assert.equal(resolved, cmdPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

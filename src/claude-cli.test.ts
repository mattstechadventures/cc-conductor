import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareClaudeVersions,
  formatClaudeVersion,
  getMinimumClaudeVersion,
  parseClaudeVersion,
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

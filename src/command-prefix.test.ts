import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_COMMAND_PREFIX,
  formatCommand,
  getCommandPrefix,
  parseCommand,
} from './command-prefix.js';

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const original = process.env.COMMAND_PREFIX;
  if (env.COMMAND_PREFIX === undefined) {
    delete process.env.COMMAND_PREFIX;
  } else {
    process.env.COMMAND_PREFIX = env.COMMAND_PREFIX;
  }

  try {
    return fn();
  } finally {
    if (original === undefined) {
      delete process.env.COMMAND_PREFIX;
    } else {
      process.env.COMMAND_PREFIX = original;
    }
  }
}

test('command prefix falls back to the default when the env var is missing or blank', () => {
  assert.equal(withEnv({ COMMAND_PREFIX: undefined }, () => getCommandPrefix()), DEFAULT_COMMAND_PREFIX);
  assert.equal(withEnv({ COMMAND_PREFIX: '   ' }, () => getCommandPrefix()), DEFAULT_COMMAND_PREFIX);
});

test('command prefix env overrides apply to formatting and parsing', () => {
  withEnv({ COMMAND_PREFIX: '!' }, () => {
    assert.equal(formatCommand('help'), '!help');
    assert.deepEqual(parseCommand('  !Run   now  please  '), {
      name: 'run',
      args: ['now', 'please'],
    });
  });
});

test('parseCommand rejects non-matching or empty commands', () => {
  withEnv({ COMMAND_PREFIX: '/' }, () => {
    assert.equal(parseCommand('help me'), null);
    assert.equal(parseCommand('   /   '), null);
    assert.deepEqual(parseCommand('/STATUS all'), {
      name: 'status',
      args: ['all'],
    });
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildBackendHandoffPrompt, buildResumePrompt, mergeCheckpointMessages } from './handoff.js';
import type { Checkpoint, CheckpointMessage, Session } from './types.js';

const baseSession: Session = {
  id: 'session-1',
  name: 'bookshelf',
  discordChannelId: 'discord-channel',
  discordChannelName: 'bookshelf',
  tmuxSession: null,
  projectDir: '/tmp/bookshelf',
  additionalDirs: [],
  pid: null,
  status: 'starting',
  createdAt: 1_000_000,
  lastActiveAt: 1_000_000,
  lastCheckpointAt: null,
  checkpointPath: null,
  resumeCount: 2,
  interruptedAt: 1_200_000,
  indicatorMode: null,
  workerId: null,
  terminalBackend: 'pty',
  terminalHandle: null,
  transportKind: 'channel',
  transportState: 'disconnected',
  activeBackend: 'claude',
  backendStates: [],
  claudeSessionName: 'bookshelf',
  claudeResumeRef: 'bookshelf',
  workerStatus: 'starting',
};

test('mergeCheckpointMessages deduplicates near-identical messages and keeps chronological order', () => {
  const checkpointMessages: CheckpointMessage[] = [
    { author: 'user', content: 'from checkpoint duplicate', timestamp: 1_000 },
    { author: 'assistant', content: 'older checkpoint message', timestamp: 7_000 },
    { author: 'user', content: 'checkpoint-only', timestamp: 9_000 },
  ];
  const liveMessages: CheckpointMessage[] = [
    { author: 'user', content: 'live duplicate', timestamp: 1_500 },
    { author: 'assistant', content: 'live message', timestamp: 5_000 },
  ];

  assert.deepEqual(mergeCheckpointMessages(checkpointMessages, liveMessages), [
    { author: 'user', content: 'live duplicate', timestamp: 1_500 },
    { author: 'assistant', content: 'live message', timestamp: 5_000 },
    { author: 'assistant', content: 'older checkpoint message', timestamp: 7_000 },
    { author: 'user', content: 'checkpoint-only', timestamp: 9_000 },
  ]);
});

test('buildResumePrompt includes fallback text and current timing context', () => {
  const checkpoint: Checkpoint = {
    sessionId: baseSession.id,
    sessionName: baseSession.name,
    projectDir: baseSession.projectDir,
    writtenAt: 1_200_000,
    gitBranch: null,
    gitLastCommit: null,
    taskSummary: null,
    recentMessages: [],
  };
  const originalNow = Date.now;
  Date.now = () => 1_260_000;

  try {
    const prompt = buildResumePrompt(baseSession, checkpoint, []);
    assert.match(prompt, /Resume #3/);
    assert.match(prompt, /Interrupted: 1970-01-01T00:20:00\.000Z \(1 minutes ago\)/);
    assert.match(prompt, /No task summary available\./);
    assert.match(prompt, /Branch: unknown/);
    assert.match(prompt, /Last commit: unknown/);
    assert.match(prompt, /No recent messages available\./);
  } finally {
    Date.now = originalNow;
  }
});

test('buildBackendHandoffPrompt falls back to checkpoint git state and trims older transcript lines', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-prompt-'));
  const session: Session = {
    ...baseSession,
    activeBackend: 'codex',
    projectDir: tempDir,
  };
  const checkpoint: Checkpoint = {
    sessionId: session.id,
    sessionName: session.name,
    projectDir: session.projectDir,
    writtenAt: 1_200_000,
    gitBranch: 'checkpoint-branch',
    gitLastCommit: 'checkpoint-commit',
    taskSummary: 'Continue refactoring the worker bridge.',
    recentMessages: [],
  };
  const messages: CheckpointMessage[] = Array.from({ length: 45 }, (_, index) => ({
    author: index % 2 === 0 ? 'user' : 'claude',
    content: `message-${index}`,
    timestamp: 1_000 + index,
  }));

  try {
    const prompt = buildBackendHandoffPrompt({
      session,
      checkpoint,
      messages,
      sourceBackend: 'claude',
      targetBackend: 'codex',
    });

    assert.match(prompt, /You are Codex\./);
    assert.match(prompt, /Branch: checkpoint-branch/);
    assert.match(prompt, /Last commit: checkpoint-commit/);
    assert.match(prompt, /Continue refactoring the worker bridge\./);
    assert.match(prompt, /Recent Discord transcript \(45 messages\)/);
    assert.match(prompt, /message-44/);
    assert.match(prompt, /message-5/);
    assert.doesNotMatch(prompt, /\n(?:user|claude): message-0\n/);
    assert.doesNotMatch(prompt, /\n(?:user|claude): message-1\n/);
    assert.doesNotMatch(prompt, /\n(?:user|claude): message-2\n/);
    assert.doesNotMatch(prompt, /\n(?:user|claude): message-3\n/);
    assert.doesNotMatch(prompt, /\n(?:user|claude): message-4\n/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

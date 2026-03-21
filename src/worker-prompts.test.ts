import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTerminalOutput } from './worker-prompts.js';

test('development channel consent is not treated as a ready prompt', () => {
  const output = [
    '\u001b[38;2;255;107;128mWARNING: Loading development channels',
    '--dangerously-load-development-channels is for local channel development only.',
    'Channels: server:conductor-discord',
    '❯ 1. I am using this for local development',
    '2. Exit',
    'Enter to confirm',
  ].join('\n');

  const signals = analyzeTerminalOutput(output);
  assert.equal(signals.isDevelopmentChannelPrompt, true);
  assert.equal(signals.isOutsideAllowedDirectoryPrompt, false);
  assert.equal(signals.isReadyPrompt, false);
});

test('startup prompts are detected even when ANSI cursor movement collapses spaces', () => {
  const output = [
    'Accessingworkspace:C:\\Users\\claed\\projects\\test6Quicksafetycheck:Isthisaprojectyoucreatedoroneyoutrust?',
    '❯1.Yes,Itrustthisfolder2.No,exitEntertoconfirm·Esctocancel',
    'WARNING:Loadingdevelopmentchannels',
    'Channels:server:conductor-discord-8wwhq4it❯1.Iamusingthisforlocaldevelopment2.ExitEntertoconfirm·Esctocancel',
  ].join('\n');

  const signals = analyzeTerminalOutput(output);
  assert.equal(signals.isTrustPrompt, true);
  assert.equal(signals.isDevelopmentChannelPrompt, true);
  assert.equal(signals.isOutsideAllowedDirectoryPrompt, false);
  assert.equal(signals.isReadyPrompt, false);
});

test('current MCP approval prompt is detected and accepted with enter', () => {
  const output = [
    'Do you want to proceed?',
    '❯ 1. Yes',
    "2. Yes, and don't ask again for conductor-discord - reply commands in d:\\repos",
    '3. No',
  ].join('\n');

  const signals = analyzeTerminalOutput(output);
  assert.equal(signals.isPermissionPrompt, true);
  assert.equal(signals.isOutsideAllowedDirectoryPrompt, false);
  assert.equal(signals.permissionPromptAction, 'enter');
  assert.equal(signals.isReadyPrompt, false);
});

test('ready prompt wins once live Claude UI is visible in the same buffer', () => {
  const output = [
    'WARNING:Loadingdevelopmentchannels',
    'Channels:server:conductor-discord-covvljmg❯1.Iamusingthisforlocaldevelopment2.ExitEntertoconfirm·Esctocancel',
    'Listening for channel messages from: server:conductor-discord-covvljmg',
    '❯ ',
    '⏵⏵accept edits on (shift+tab to cycle)',
  ].join('\n');

  const signals = analyzeTerminalOutput(output);
  assert.equal(signals.isDevelopmentChannelPrompt, true);
  assert.equal(signals.isReadyPrompt, true);
});

test('outside-directory access prompts are classified separately from internal approvals', () => {
  const output = [
    'Bash command',
    'ls "d:/repos" 2>&1 || ls "d:/Repos" 2>&1 || echo "Not found"',
    'Do you want to proceed?',
    '❯ 1. Yes',
    '2. Yes, allow reading from repos\\ and Repos\\ from this project',
    '3. No',
  ].join('\n');

  const signals = analyzeTerminalOutput(output);
  assert.equal(signals.isOutsideAllowedDirectoryPrompt, true);
  assert.equal(signals.blockedDirectoryPath, 'd:/Repos');
  assert.equal(signals.isPermissionPrompt, false);
  assert.equal(signals.permissionPromptAction, null);
  assert.equal(signals.isReadyPrompt, false);
});

test('legacy permission prompt is still detected', () => {
  const output = [
    '❯ 1. No, exit',
    '2. Yes, I accept',
  ].join('\n');

  const signals = analyzeTerminalOutput(output);
  assert.equal(signals.isPermissionPrompt, true);
  assert.equal(signals.isOutsideAllowedDirectoryPrompt, false);
  assert.equal(signals.permissionPromptAction, 'down-enter');
  assert.equal(signals.isReadyPrompt, false);
});

test('ready prompt is detected once no startup gate is present', () => {
  const output = [
    'Claude Code',
    'Project: d:\\repos',
    '❯ ',
  ].join('\n');

  const signals = analyzeTerminalOutput(output);
  assert.equal(signals.isTrustPrompt, false);
  assert.equal(signals.isDevelopmentChannelPrompt, false);
  assert.equal(signals.isPermissionPrompt, false);
  assert.equal(signals.isOutsideAllowedDirectoryPrompt, false);
  assert.equal(signals.permissionPromptAction, null);
  assert.equal(signals.blockedDirectoryPath, null);
  assert.equal(signals.isReadyPrompt, true);
});

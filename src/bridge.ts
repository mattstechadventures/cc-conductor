/**
 * Terminal Bridge — relays messages between Discord channels and Claude Code tmux sessions.
 *
 * Discord → Claude Code: captures messages in session channels, sends via tmux send-keys
 * Claude Code → Discord: polls tmux capture-pane to detect new output, posts to Discord
 */

import { Client, TextChannel } from 'discord.js';
import { sendKeys, capturePaneOutput, tmuxSessionExists } from './tmux.js';
import { updateSessionActivity } from './sessions.js';
import { logger } from './logger.js';
import type { Session } from './types.js';

interface BridgeState {
  session: Session;
  lastPaneContent: string;
  lastPaneLineCount: number;
  pollTimer: ReturnType<typeof setInterval> | null;
  isProcessing: boolean;
  outputBuffer: string;
  quietTicks: number; // consecutive polls with no new output
}

const bridges = new Map<string, BridgeState>(); // sessionId → state
const POLL_INTERVAL_MS = 1500;
const QUIET_TICKS_THRESHOLD = 2; // after 2 consecutive quiet polls, flush output

/**
 * Start bridging a session — poll tmux for output and relay to Discord.
 */
export function startBridge(session: Session, discordClient: Client): void {
  if (bridges.has(session.id)) {
    logger.warn(`Bridge already active for session ${session.name}`);
    return;
  }

  const state: BridgeState = {
    session,
    lastPaneContent: '',
    lastPaneLineCount: 0,
    pollTimer: null,
    isProcessing: false,
    outputBuffer: '',
    quietTicks: 0,
  };

  // Take initial snapshot so we don't replay existing pane content
  state.lastPaneContent = capturePaneOutput(session.tmuxSession, 200);
  state.lastPaneLineCount = state.lastPaneContent.split('\n').length;

  // Start polling
  state.pollTimer = setInterval(() => {
    pollPane(state, discordClient).catch(err => {
      logger.error(`Bridge poll error for ${session.name}: ${err.message}`);
    });
  }, POLL_INTERVAL_MS);

  bridges.set(session.id, state);
  logger.info(`Bridge started for session ${session.name}`);
}

/**
 * Stop bridging a session.
 */
export function stopBridge(sessionId: string): void {
  const state = bridges.get(sessionId);
  if (!state) return;

  if (state.pollTimer) {
    clearInterval(state.pollTimer);
  }
  bridges.delete(sessionId);
  logger.info(`Bridge stopped for session ${state.session.name}`);
}

/**
 * Stop all active bridges.
 */
export function stopAllBridges(): void {
  for (const [id] of bridges) {
    stopBridge(id);
  }
}

/**
 * Send a Discord message into a Claude Code session via tmux.
 */
export function sendToSession(session: Session, message: string): void {
  if (!tmuxSessionExists(session.tmuxSession)) {
    logger.warn(`Cannot send to ${session.name}: tmux session gone`);
    return;
  }

  const state = bridges.get(session.id);
  if (state) {
    state.isProcessing = true;
    state.quietTicks = 0;
    state.outputBuffer = '';
  }

  // Send the message as keystrokes into the tmux pane
  sendKeys(session.tmuxSession, message);
  updateSessionActivity(session.id);
}

/**
 * Poll the tmux pane for new output from Claude Code.
 */
async function pollPane(state: BridgeState, discordClient: Client): Promise<void> {
  if (!tmuxSessionExists(state.session.tmuxSession)) {
    logger.warn(`Session ${state.session.name}: tmux gone during poll`);
    stopBridge(state.session.id);
    return;
  }

  const currentContent = capturePaneOutput(state.session.tmuxSession, 200);

  if (currentContent === state.lastPaneContent) {
    // No change
    if (state.isProcessing) {
      state.quietTicks++;
      if (state.quietTicks >= QUIET_TICKS_THRESHOLD && state.outputBuffer.length > 0) {
        // Claude has stopped outputting — flush to Discord
        await flushToDiscord(state, discordClient);
      }
    }
    return;
  }

  // Content changed — extract the new portion
  const newContent = extractNewContent(state.lastPaneContent, currentContent);
  state.lastPaneContent = currentContent;

  if (newContent && state.isProcessing) {
    // Filter out UI chrome and accumulate meaningful output
    const cleaned = cleanOutput(newContent);
    if (cleaned) {
      state.outputBuffer += cleaned;
      state.quietTicks = 0;
    }
  }
}

/**
 * Extract content that is new compared to the previous capture.
 */
function extractNewContent(previous: string, current: string): string {
  const prevLines = previous.split('\n');
  const currLines = current.split('\n');

  // Find where the new content starts by looking for the last matching line
  // from the previous content in the current content
  if (prevLines.length === 0) return current;

  // Use the last few lines of previous as an anchor
  const anchorSize = Math.min(3, prevLines.length);
  const anchor = prevLines.slice(-anchorSize).join('\n');

  const anchorIdx = current.lastIndexOf(anchor);
  if (anchorIdx === -1) {
    // Complete change — return everything after the input prompt
    return extractAfterPrompt(current);
  }

  const afterAnchor = current.slice(anchorIdx + anchor.length);
  return afterAnchor.trim();
}

/**
 * Try to extract Claude's response after the user's input prompt line.
 */
function extractAfterPrompt(content: string): string {
  const lines = content.split('\n');
  // Look for the prompt indicator (❯) and take everything after it
  let lastPromptIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('❯') && !lines[i].includes('────')) {
      lastPromptIdx = i;
      break;
    }
  }
  if (lastPromptIdx >= 0 && lastPromptIdx < lines.length - 1) {
    return lines.slice(lastPromptIdx + 1).join('\n').trim();
  }
  return '';
}

/**
 * Clean Claude Code terminal output — strip ANSI codes, box drawing, and UI chrome.
 */
function cleanOutput(raw: string): string {
  let cleaned = raw
    // Strip ANSI escape codes
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    // Strip box drawing characters and horizontal rules
    .replace(/[╭╮╰╯│├┤┬┴┼─═║╔╗╚╝╠╣╦╩╬]/g, '')
    .replace(/[─━┄┅┈┉╌╍]/g, '')
    .replace(/────+/g, '')
    // Strip the prompt line
    .replace(/^❯\s*$/gm, '')
    // Strip status bar content
    .replace(/📁.*🤖.*$/gm, '')
    // Strip tool use headers
    .replace(/^\s*⎿\s*$/gm, '')
    // Collapse multiple blank lines
    .replace(/\n{3,}/g, '\n\n');

  cleaned = cleaned.trim();

  // Skip if it's just whitespace or very short UI fragments
  if (cleaned.length < 3) return '';
  // Skip if it looks like just a prompt
  if (/^❯\s*$/.test(cleaned)) return '';

  return cleaned;
}

/**
 * Send accumulated output to the Discord channel.
 */
async function flushToDiscord(state: BridgeState, discordClient: Client): Promise<void> {
  const output = state.outputBuffer.trim();
  state.outputBuffer = '';
  state.isProcessing = false;
  state.quietTicks = 0;

  if (!output) return;

  try {
    const channel = await discordClient.channels.fetch(state.session.discordChannelId) as TextChannel | null;
    if (!channel) return;

    // Discord 2000 char limit — split into chunks
    const chunks = splitMessage(output, 1900);
    for (const chunk of chunks) {
      await channel.send(chunk);
    }
  } catch (err: any) {
    logger.error(`Failed to send to Discord for ${state.session.name}: ${err.message}`);
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx <= 0) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }
  return chunks;
}

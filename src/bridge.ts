/**
 * Terminal Bridge — relays messages between Discord channels and Claude Code tmux sessions.
 *
 * Discord → Claude Code: sends user messages via tmux send-keys
 * Claude Code → Discord: polls tmux capture-pane for new output, posts to Discord
 */

import { Client, TextChannel } from 'discord.js';
import { sendKeys, capturePaneOutput, tmuxSessionExists } from './tmux.js';
import { updateSessionActivity } from './sessions.js';
import { logger } from './logger.js';
import type { Session } from './types.js';

interface BridgeState {
  session: Session;
  pollTimer: ReturnType<typeof setInterval> | null;
  /** The message we last sent — used to locate Claude's response in the pane */
  lastSentMessage: string;
  /** Whether we're waiting for Claude to finish responding */
  waitingForResponse: boolean;
  /** How many consecutive polls showed no pane change */
  stableTicks: number;
  /** Last captured pane for change detection */
  lastPaneHash: string;
  /** Whether we've already seen partial output (Claude started responding) */
  sawOutput: boolean;
}

const bridges = new Map<string, BridgeState>();
const POLL_MS = 1500;
/** After this many stable polls while Claude is done, flush */
const STABLE_THRESHOLD = 2;

export function startBridge(session: Session, discordClient: Client): void {
  if (bridges.has(session.id)) return;

  const state: BridgeState = {
    session,
    pollTimer: null,
    lastSentMessage: '',
    waitingForResponse: false,
    stableTicks: 0,
    lastPaneHash: '',
    sawOutput: false,
  };

  state.pollTimer = setInterval(() => {
    tick(state, discordClient).catch(err =>
      logger.error(`Bridge tick error for ${session.name}: ${err.message}`)
    );
  }, POLL_MS);

  bridges.set(session.id, state);
  logger.info(`Bridge started for session ${session.name}`);
}

export function stopBridge(sessionId: string): void {
  const state = bridges.get(sessionId);
  if (!state) return;
  if (state.pollTimer) clearInterval(state.pollTimer);
  bridges.delete(sessionId);
  logger.info(`Bridge stopped for session ${state.session.name}`);
}

export function stopAllBridges(): void {
  for (const [id] of bridges) stopBridge(id);
}

export function sendToSession(session: Session, message: string): void {
  if (!tmuxSessionExists(session.tmuxSession)) {
    logger.warn(`Cannot send to ${session.name}: tmux session gone`);
    return;
  }

  const state = bridges.get(session.id);
  if (state) {
    state.lastSentMessage = message;
    state.waitingForResponse = true;
    state.stableTicks = 0;
    state.lastPaneHash = '';
    state.sawOutput = false;
  }

  sendKeys(session.tmuxSession, message);
  updateSessionActivity(session.id);
  logger.info(`Bridge sent to ${session.name}: ${message.substring(0, 60)}`);
}

// ── internal ──

async function tick(state: BridgeState, discordClient: Client): Promise<void> {
  if (!state.waitingForResponse) return;
  if (!tmuxSessionExists(state.session.tmuxSession)) {
    stopBridge(state.session.id);
    return;
  }

  const pane = capturePaneOutput(state.session.tmuxSession, 500);
  const paneHash = simpleHash(pane);

  // Check if pane changed
  if (paneHash === state.lastPaneHash) {
    state.stableTicks++;
  } else {
    state.stableTicks = 0;
    state.lastPaneHash = paneHash;
  }

  // Look for Claude's response: find content between our sent message and the final ❯ prompt
  const response = extractResponse(pane, state.lastSentMessage);

  if (response) {
    state.sawOutput = true;
  }

  // Check if Claude is back at the prompt (done responding)
  const lines = pane.trimEnd().split('\n');
  const lastFewLines = lines.slice(-5).join('\n');
  const atPrompt = lastFewLines.includes('❯') &&
    !lastFewLines.includes('Running') &&
    !lastFewLines.includes('Waiting') &&
    !lastFewLines.includes('Simmering');

  // Flush when: Claude is at prompt AND pane is stable AND we have output
  if (atPrompt && state.stableTicks >= STABLE_THRESHOLD && response) {
    await flushResponse(state, response, discordClient);
  }
}

/**
 * Extract Claude's response text from the pane.
 * Finds everything between the sent message and the final ❯ prompt.
 */
function extractResponse(pane: string, sentMessage: string): string | null {
  if (!sentMessage) return null;

  // Find the sent message in the pane (use first 50 chars to avoid wrapping issues)
  const searchStr = sentMessage.substring(0, 50);
  const msgIdx = pane.lastIndexOf(searchStr);
  if (msgIdx === -1) return null;

  // Skip past the sent message line
  const afterMsg = pane.slice(msgIdx + searchStr.length);
  const lines = afterMsg.split('\n');

  // Skip the rest of the message line
  const responseLines: string[] = [];
  let started = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines at the start
    if (!started && !trimmed) continue;

    // Skip the input line itself (may wrap)
    if (!started && trimmed === sentMessage.substring(50).trim()) continue;

    // Start collecting after we see Claude's output marker.
    // Different Claude Code versions use different bullet characters:
    //   ⏺ (U+23FA), ● (U+25CF), ⏵ (U+23F5), ○ (U+25CB), • (U+2022)
    const OUTPUT_MARKERS = ['⏺', '●', '⏵', '○', '•'];
    if (!started && OUTPUT_MARKERS.some(m => trimmed.startsWith(m))) {
      started = true;
    }

    if (started) {
      // Stop at the final prompt
      if (trimmed === '❯') break;
      // Stop at status bar
      if (trimmed.startsWith('📁')) break;
      // Stop at separator lines
      if (/^─{20,}$/.test(trimmed)) break;

      responseLines.push(line);
    }
  }

  if (responseLines.length === 0) return null;

  // Clean the output
  const cleaned = responseLines
    .map(l => l
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // ANSI codes
      .replace(/\x1b\][^\x07]*\x07/g, '')       // OSC sequences
    )
    .join('\n')
    .trim();

  return cleaned || null;
}

async function flushResponse(state: BridgeState, response: string, discordClient: Client): Promise<void> {
  state.waitingForResponse = false;
  state.stableTicks = 0;

  try {
    const channel = await discordClient.channels.fetch(state.session.discordChannelId) as TextChannel | null;
    if (!channel) return;

    const chunks = splitMsg(response, 1900);
    for (const chunk of chunks) {
      await channel.send(chunk);
    }
    logger.info(`Bridge flushed ${response.length} chars to Discord for ${state.session.name}`);
  } catch (err: any) {
    logger.error(`Bridge flush error for ${state.session.name}: ${err.message}`);
  }
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

function splitMsg(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    let i = rest.lastIndexOf('\n', max);
    if (i <= 0) i = max;
    chunks.push(rest.slice(0, i));
    rest = rest.slice(i).trimStart();
  }
  return chunks;
}

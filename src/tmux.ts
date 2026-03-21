import { execSync } from 'child_process';
import { logger } from './logger.js';

const CONDUCTOR_PREFIX = 'conductor-';

function exec(cmd: string, retries = 1): string {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return execSync(cmd, { encoding: 'utf-8', timeout: 10_000 }).trim();
    } catch (err: any) {
      if (attempt < retries) {
        logger.warn(`tmux command failed, retrying: ${cmd}`);
        continue;
      }
      throw new Error(`tmux command failed: ${cmd}\n${err.message}`);
    }
  }
  return '';
}

export function createTmuxSession(sessionName: string, workDir: string): void {
  exec(`tmux new-session -d -s ${quote(sessionName)} -c ${quote(workDir)}`, 0);
  logger.info(`Created tmux session: ${sessionName} in ${workDir}`);
}

export function sendKeys(sessionName: string, command: string): void {
  // Use tmux send-keys with literal string to avoid shell interpretation issues
  exec(`tmux send-keys -t ${quote(sessionName)} ${quote(command)} Enter`, 0);
  logger.info(`Sent keys to ${sessionName}: ${command.substring(0, 80)}...`);
}

export function killTmuxSession(sessionName: string): void {
  try {
    exec(`tmux kill-session -t ${quote(sessionName)}`, 0);
    logger.info(`Killed tmux session: ${sessionName}`);
  } catch {
    logger.warn(`Could not kill tmux session (may already be dead): ${sessionName}`);
  }
}

export function tmuxSessionExists(sessionName: string): boolean {
  try {
    exec(`tmux has-session -t ${quote(sessionName)}`, 0);
    return true;
  } catch {
    return false;
  }
}

export function getSessionPid(sessionName: string): number | null {
  try {
    const output = exec(
      `tmux list-panes -t ${quote(sessionName)} -F '#{pane_pid}'`,
      0
    );
    const pid = parseInt(output.split('\n')[0], 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function listConductorSessions(): string[] {
  try {
    const output = exec('tmux list-sessions -F "#{session_name}"', 0);
    if (!output) return [];
    return output
      .split('\n')
      .filter(name => name.startsWith(CONDUCTOR_PREFIX));
  } catch {
    // tmux server not running — no sessions
    return [];
  }
}

export function capturePaneOutput(sessionName: string, lines = 50): string {
  try {
    return exec(
      `tmux capture-pane -t ${quote(sessionName)} -p -S -${lines}`,
      0
    );
  } catch {
    return '';
  }
}

function quote(s: string): string {
  // Shell-safe quoting using single quotes with escape
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

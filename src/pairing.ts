import path from 'path';
import { fileURLToPath } from 'url';
import type { Session } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.resolve(__dirname, '..', 'plugin', 'discord-autopair');

export function buildClaudeCommand(session: Session, resumePromptPath?: string): string {
  // Environment variables are set as a prefix so they propagate to the plugin subprocess
  const envVars = [
    `CONDUCTOR_CHANNEL_ID=${session.discordChannelId}`,
    `CONDUCTOR_SESSION_NAME=${session.name}`,
    `CONDUCTOR_PROJECT_DIR=${session.projectDir}`,
    `DISCORD_BOT_TOKEN=${process.env.DISCORD_BOT_TOKEN || ''}`,
  ];

  if (resumePromptPath) {
    envVars.push(`CONDUCTOR_RESUME_PROMPT_PATH=${resumePromptPath}`);
  }

  const envPrefix = envVars.join(' ');

  // --plugin-dir loads a plugin directory that contains .mcp.json
  // This enables the claude/channel capability, which --mcp-config alone may not
  return `${envPrefix} claude --plugin-dir ${quote(PLUGIN_DIR)}`;
}

function quote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

#!/usr/bin/env bun
/**
 * Discord Auto-Pair Channel Plugin for Claude Code (Conductor)
 *
 * MCP server that bridges a Discord channel to a Claude Code session.
 * Loaded via `claude --dangerously-load-development-channels`.
 *
 * Environment variables:
 *   DISCORD_BOT_TOKEN            — Discord bot token (required)
 *   CONDUCTOR_CHANNEL_ID         — Auto-pair to this channel ID
 *   CONDUCTOR_SESSION_NAME       — Session name for status messages
 *   CONDUCTOR_PROJECT_DIR        — Project directory for status messages
 *   CONDUCTOR_RESUME_PROMPT_PATH — Path to resume prompt file (injected on startup)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  Client,
  GatewayIntentBits,
  TextChannel,
  Events,
} from 'discord.js';
import fs from 'fs';

// --- Config ---
const CHANNEL_ID = process.env.CONDUCTOR_CHANNEL_ID;
const SESSION_NAME = process.env.CONDUCTOR_SESSION_NAME || 'unknown';
const PROJECT_DIR = process.env.CONDUCTOR_PROJECT_DIR || process.cwd();
const RESUME_PROMPT_PATH = process.env.CONDUCTOR_RESUME_PROMPT_PATH;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('[discord-autopair] DISCORD_BOT_TOKEN is required');
  process.exit(1);
}

if (!CHANNEL_ID) {
  console.error('[discord-autopair] CONDUCTOR_CHANNEL_ID is required');
  process.exit(1);
}

// --- MCP Server ---
const mcp = new Server(
  { name: 'discord-autopair', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {} },
    },
    instructions: [
      `Events from the Discord channel #${SESSION_NAME} arrive as <channel source="discord-autopair" ...>.`,
      'Each event has a chat_id, user, and message_id in the attributes.',
      'Use the "reply" tool to respond. Always include chat_id so the reply goes to the right channel.',
      'Keep responses concise for Discord — split very long responses if needed.',
    ].join(' '),
  }
);

// --- Tools: what Claude can call ---
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Reply to a Discord message in the session channel',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string', description: 'The channel ID to reply in' },
          message: { type: 'string', description: 'The message content to send' },
        },
        required: ['chat_id', 'message'],
      },
    },
    {
      name: 'react',
      description: 'Add a reaction emoji to a Discord message',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string', description: 'The channel ID' },
          message_id: { type: 'string', description: 'The message ID to react to' },
          emoji: { type: 'string', description: 'The emoji to react with' },
        },
        required: ['chat_id', 'message_id', 'emoji'],
      },
    },
  ],
}));

// --- Tool execution ---
let pairedChannel: TextChannel | null = null;

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'reply') {
    const message = (args as any).message as string;
    if (!pairedChannel) {
      return { content: [{ type: 'text', text: 'Error: channel not connected' }] };
    }

    // Discord 2000 char limit — split if needed
    const chunks = splitMessage(message, 1900);
    for (const chunk of chunks) {
      await pairedChannel.send(chunk);
    }

    return { content: [{ type: 'text', text: `Sent ${chunks.length} message(s)` }] };
  }

  if (name === 'react') {
    const { message_id, emoji } = args as any;
    if (!pairedChannel) {
      return { content: [{ type: 'text', text: 'Error: channel not connected' }] };
    }

    try {
      const msg = await pairedChannel.messages.fetch(message_id);
      await msg.react(emoji);
      return { content: [{ type: 'text', text: 'Reacted' }] };
    } catch (err: any) {
      return { content: [{ type: 'text', text: `React failed: ${err.message}` }] };
    }
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
});

// --- Discord client ---
const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

await discord.login(BOT_TOKEN);

await new Promise<void>((resolve) => {
  discord.once(Events.ClientReady, () => {
    console.error(`[discord-autopair] Discord ready (session: ${SESSION_NAME})`);
    resolve();
  });
});

// --- Connect to MCP transport (must happen before sending notifications) ---
const transport = new StdioServerTransport();
await mcp.connect(transport);
console.error(`[discord-autopair] MCP server connected`);

// --- Auto-pair to channel ---
const channel = await discord.channels.fetch(CHANNEL_ID!);
if (!channel || !(channel instanceof TextChannel)) {
  console.error(`[discord-autopair] Channel ${CHANNEL_ID} not found or not a text channel`);
  process.exit(1);
}
pairedChannel = channel;
console.error(`[discord-autopair] Paired to #${channel.name}`);

// --- Inject resume prompt if available ---
if (RESUME_PROMPT_PATH && fs.existsSync(RESUME_PROMPT_PATH)) {
  const resumePrompt = fs.readFileSync(RESUME_PROMPT_PATH, 'utf-8');
  console.error(`[discord-autopair] Injecting resume prompt (${resumePrompt.length} chars)`);
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: resumePrompt,
      meta: {
        chat_id: CHANNEL_ID!,
        user: 'conductor',
        message_id: `resume-${Date.now()}`,
      },
    },
  });
  try { fs.unlinkSync(RESUME_PROMPT_PATH); } catch { /* ok */ }
}

// --- Post ready message ---
await pairedChannel.send(
  `✓ Session **${SESSION_NAME}** is live. Claude Code is running in \`${PROJECT_DIR}\`.`
);

// --- Forward Discord messages to Claude Code ---
discord.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== CHANNEL_ID) return;

  console.error(`[discord-autopair] <- ${message.author.username}: ${message.content.substring(0, 80)}`);

  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: message.content,
      meta: {
        chat_id: CHANNEL_ID!,
        user: message.author.username,
        message_id: message.id,
        ts: message.createdTimestamp.toString(),
      },
    },
  });
});

// --- Cleanup on exit ---
async function cleanup() {
  if (pairedChannel) {
    try {
      await pairedChannel.send(`⚠ Session **${SESSION_NAME}** has ended.`);
    } catch { /* ok */ }
  }
  discord.destroy();
  console.error(`[discord-autopair] Shutdown (session: ${SESSION_NAME})`);
}

process.on('SIGTERM', async () => { await cleanup(); process.exit(0); });
process.on('SIGINT', async () => { await cleanup(); process.exit(0); });
process.on('beforeExit', cleanup);

// --- Helpers ---
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx <= 0) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx);
  }
  return chunks;
}

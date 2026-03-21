import fs from 'fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { logger } from './logger.js';
import type { ChannelQueuedEvent } from './types.js';

const daemonUrl = requiredEnv('CONDUCTOR_DAEMON_URL');
const sessionId = requiredEnv('CONDUCTOR_SESSION_ID');
const channelToken = requiredEnv('CONDUCTOR_CHANNEL_TOKEN');
const channelServerName = process.env.CONDUCTOR_CHANNEL_SERVER_NAME || 'conductor-discord';
const discordChannelId = process.env.CONDUCTOR_CHANNEL_ID || '';
const sessionName = process.env.CONDUCTOR_SESSION_NAME || sessionId;
const resumePromptPath = process.env.CONDUCTOR_RESUME_PROMPT_PATH || '';

const mcp = new Server(
  { name: channelServerName, version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {} },
    },
    instructions: [
      `Events from the Discord channel bridge arrive as <channel source="${channelServerName}" ...>.`,
      'Use the reply tool for any user-facing response and pass the chat_id attribute from the tag.',
      'Use the react tool sparingly for lightweight acknowledgements.',
    ].join(' '),
  }
);

let running = true;

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a message back to the Discord session channel',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string', description: 'The Discord channel ID to reply in' },
          message: { type: 'string', description: 'The message to send' },
        },
        required: ['chat_id', 'message'],
      },
    },
    {
      name: 'react',
      description: 'React to a Discord message in the session channel',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string', description: 'The Discord channel ID' },
          message_id: { type: 'string', description: 'The Discord message ID to react to' },
          emoji: { type: 'string', description: 'The emoji to add' },
        },
        required: ['chat_id', 'message_id', 'emoji'],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = (request.params.arguments || {}) as Record<string, unknown>;

  if (toolName === 'reply') {
    await daemonPost('/reply', {
      chatId: String(args.chat_id || ''),
      message: String(args.message || ''),
    });
    return { content: [{ type: 'text', text: 'sent' }] };
  }

  if (toolName === 'react') {
    await daemonPost('/react', {
      chatId: String(args.chat_id || ''),
      messageId: String(args.message_id || ''),
      emoji: String(args.emoji || ''),
    });
    return { content: [{ type: 'text', text: 'reacted' }] };
  }

  throw new Error(`Unknown tool: ${toolName}`);
});

async function main(): Promise<void> {
  await mcp.connect(new StdioServerTransport());
  await registerChannel();
  await injectResumePrompt();
  void pollLoop();
}

async function pollLoop(): Promise<void> {
  while (running) {
    try {
      await registerChannel();
      const res = await fetch(`${daemonUrl}/internal/sessions/${sessionId}/channel/events?timeoutMs=25000`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${channelToken}`,
        },
      });

      if (res.status === 204) {
        continue;
      }

      if (!res.ok) {
        await sleep(1_000);
        continue;
      }

      const event = await res.json() as ChannelQueuedEvent;
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: event.content,
          meta: event.meta,
        },
      });
    } catch (err: any) {
      logger.warn(`Channel poll loop error for ${sessionName}: ${err.message}`);
      await sleep(1_000);
    }
  }
}

async function injectResumePrompt(): Promise<void> {
  if (!resumePromptPath || !fs.existsSync(resumePromptPath)) return;
  const resumePrompt = fs.readFileSync(resumePromptPath, 'utf-8');
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: resumePrompt,
      meta: {
        ...(discordChannelId ? { chat_id: discordChannelId } : {}),
        source: 'conductor-resume',
        session_id: sessionId,
      },
    },
  });
  try {
    fs.unlinkSync(resumePromptPath);
  } catch {
    // best effort
  }
}

async function registerChannel(): Promise<void> {
  await fetch(`${daemonUrl}/internal/sessions/${sessionId}/channel/register`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${channelToken}`,
    },
  }).catch(() => {});
}

async function daemonPost(pathname: string, payload: unknown): Promise<void> {
  const res = await fetch(`${daemonUrl}/internal/sessions/${sessionId}/channel${pathname}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${channelToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Daemon channel request failed (${res.status})`);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cleanup(): Promise<void> {
  running = false;
  await fetch(`${daemonUrl}/internal/sessions/${sessionId}/channel/disconnect`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${channelToken}`,
    },
  }).catch(() => {});
}

process.on('SIGTERM', () => {
  void cleanup().finally(() => process.exit(0));
});
process.on('SIGINT', () => {
  void cleanup().finally(() => process.exit(0));
});

main().catch((err) => {
  logger.error(`Channel server fatal error: ${err.message}`);
  process.exit(1);
});

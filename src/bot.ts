import {
  Client, GatewayIntentBits, TextChannel, ChannelType,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ComponentType,
} from 'discord.js';
import type { Session, DaemonResponse, ResumeResult } from './types.js';
import { getSessionByChannelId, getSessionByName, getInterruptedSessions, updateSessionIndicatorMode } from './sessions.js';
import { sendToSession, getGlobalIndicatorMode, setGlobalIndicatorMode } from './bridge.js';
import type { IndicatorMode } from './types.js';
import { logger } from './logger.js';

const API_BASE = () => `http://localhost:${process.env.CONDUCTOR_API_PORT || '7842'}`;

let conductorCategoryId: string | undefined;

export function getConductorCategory(): string | undefined {
  return conductorCategoryId;
}

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });
}

export async function setupBot(client: Client): Promise<void> {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) throw new Error('DISCORD_GUILD_ID is required');

  const guild = client.guilds.cache.get(guildId);
  if (!guild) throw new Error(`Guild ${guildId} not found — is the bot invited?`);

  // Ensure Conductor category exists
  let category = guild.channels.cache.find(
    c => c.name === 'Conductor' && c.type === ChannelType.GuildCategory
  );
  if (!category) {
    category = await guild.channels.create({
      name: 'Conductor',
      type: ChannelType.GuildCategory,
    });
    logger.info('Created Conductor category');
  }
  conductorCategoryId = category.id;

  // Ensure orchestrator channel exists
  const orchName = process.env.ORCHESTRATOR_CHANNEL_NAME || 'orchestrator';
  let orchChannel = guild.channels.cache.find(
    c => c.name === orchName && c.parentId === category!.id && c.type === ChannelType.GuildText
  ) as TextChannel | undefined;

  if (!orchChannel) {
    orchChannel = await guild.channels.create({
      name: orchName,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: 'Conductor control plane — use /new, /list, /kill, /resume, /help',
    }) as TextChannel;
    logger.info(`Created #${orchName} channel`);
  }

  // Post startup message
  await orchChannel.send(
    '✓ Conductor is online. Use `/new <session-name> [<project-dir>]` to start a session.'
  );

  // Register message handler
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.guild || message.guild.id !== guildId) return;

    // Check if this is the orchestrator channel
    if (message.channel.id === orchChannel!.id) {
      await handleOrchestratorCommand(message);
      return;
    }

    // Check if this is a session channel
    const session = getSessionByChannelId(message.channel.id);
    if (session) {
      // Intercept /mode command in session channels
      if (message.content.trim().startsWith('/mode')) {
        await handleSessionMode(message, session);
        return;
      }
      // Relay to Claude Code
      if (session.status === 'active' || session.status === 'starting') {
        sendToSession(session, message.content, client);
      }
    }
  });
}

async function handleOrchestratorCommand(message: any): Promise<void> {
  const content = message.content.trim();
  if (!content.startsWith('/')) return;

  const parts = content.split(/\s+/);
  const command = parts[0].toLowerCase();

  try {
    switch (command) {
      case '/new':
        await handleNew(message, parts.slice(1));
        break;
      case '/list':
        await handleList(message);
        break;
      case '/kill':
        await handleKill(message, parts.slice(1));
        break;
      case '/resume':
        await handleResume(message, parts.slice(1));
        break;
      case '/mode':
        await handleMode(message, parts.slice(1));
        break;
      case '/help':
        await handleHelp(message);
        break;
      default:
        await message.reply(`Unknown command: ${command}. Use \`/help\` for available commands.`);
    }
  } catch (err: any) {
    logger.error(`Command handler error: ${err.message}`);
    await message.reply(`Error: ${err.message}`).catch(() => {});
  }
}

async function handleNew(message: any, args: string[]): Promise<void> {
  if (args.length < 1) {
    await message.reply('Usage: `/new <name> [dir]`');
    return;
  }

  const name = args[0];
  const dir = args[1] || undefined;

  const reply = await message.reply(`Starting session **${name}**…`);

  try {
    const res = await fetch(`${API_BASE()}/sessions/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        projectDir: dir,
        requestedBy: message.author.id,
      }),
    });

    const data = await res.json() as DaemonResponse<Session>;
    if (data.ok && data.data) {
      await reply.edit(
        `✓ Session **${name}** is live → <#${data.data.discordChannelId}>`
      );
    } else {
      await reply.edit(`Failed to start session: ${data.error}`);
    }
  } catch (err: any) {
    await reply.edit(`Failed to start session: ${err.message}`);
  }
}

async function handleList(message: any): Promise<void> {
  try {
    const res = await fetch(`${API_BASE()}/sessions`);
    const data = await res.json() as DaemonResponse<Session[]>;

    if (!data.ok || !data.data) {
      await message.reply(`Error fetching sessions: ${data.error}`);
      return;
    }

    const sessions = data.data;
    if (sessions.length === 0) {
      await message.reply('No sessions.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('Conductor Sessions')
      .setColor(0x5865f2)
      .setTimestamp();

    for (const s of sessions) {
      const statusEmoji = {
        active: '🟢',
        starting: '🟡',
        idle: '🟡',
        interrupted: '🟠',
        dead: '🔴',
      }[s.status] || '⚪';

      const age = formatDuration(Date.now() - s.createdAt);
      const lastActive = formatDuration(Date.now() - s.lastActiveAt);

      embed.addFields({
        name: `${statusEmoji} ${s.name}`,
        value: [
          `Status: **${s.status}**`,
          `Dir: \`${s.projectDir}\``,
          `Created: ${age} ago`,
          `Last active: ${lastActive} ago`,
          s.resumeCount > 0 ? `Resumes: ${s.resumeCount}` : '',
        ].filter(Boolean).join('\n'),
        inline: true,
      });
    }

    await message.reply({ embeds: [embed] });
  } catch (err: any) {
    await message.reply(`Error: ${err.message}`);
  }
}

async function handleKill(message: any, args: string[]): Promise<void> {
  if (args.length < 1) {
    await message.reply('Usage: `/kill <name>`');
    return;
  }

  const name = args[0];
  const session = getSessionByName(name);
  if (!session) {
    await message.reply(`Session "${name}" not found.`);
    return;
  }

  // Confirmation button
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('kill-confirm')
      .setLabel('Confirm')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('kill-cancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );

  const reply = await message.reply({
    content: `Kill session **${name}**? This will terminate the Claude Code process.`,
    components: [row],
  });

  try {
    const interaction = await reply.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: 30_000,
      filter: (i: any) => i.user.id === message.author.id,
    });

    if (interaction.customId === 'kill-confirm') {
      const res = await fetch(`${API_BASE()}/sessions/${session.id}`, {
        method: 'DELETE',
      });
      const data = await res.json() as DaemonResponse;
      if (data.ok) {
        await interaction.update({
          content: `✓ Session **${name}** killed.`,
          components: [],
        });
      } else {
        await interaction.update({
          content: `Failed to kill session: ${data.error}`,
          components: [],
        });
      }
    } else {
      await interaction.update({
        content: 'Kill cancelled.',
        components: [],
      });
    }
  } catch {
    // Timeout
    await reply.edit({
      content: 'Kill confirmation timed out.',
      components: [],
    });
  }
}

async function handleResume(message: any, args: string[]): Promise<void> {
  if (args.length < 1) {
    // List interrupted sessions
    const interrupted = getInterruptedSessions();
    if (interrupted.length === 0) {
      await message.reply('No interrupted sessions to resume. Usage: `/resume <name>`');
      return;
    }
    const names = interrupted.map(s => `  • **${s.name}** (interrupted ${formatDuration(Date.now() - (s.interruptedAt || s.lastActiveAt))} ago)`);
    await message.reply(`Interrupted sessions:\n${names.join('\n')}\n\nUse \`/resume <name>\` to resume.`);
    return;
  }

  const name = args[0];
  const session = getSessionByName(name);
  if (!session) {
    await message.reply(`Session "${name}" not found.`);
    return;
  }
  if (session.status !== 'interrupted') {
    await message.reply(`Session "${name}" is ${session.status}, not interrupted.`);
    return;
  }

  const reply = await message.reply(`Resuming session **${name}**…`);

  try {
    const res = await fetch(`${API_BASE()}/sessions/${session.id}/resume`, {
      method: 'POST',
    });
    const data = await res.json() as DaemonResponse<ResumeResult>;
    if (data.ok && data.data) {
      const r = data.data;
      await reply.edit(
        `↺ Session **${name}** resumed (resume #${r.session.resumeCount}) → <#${r.session.discordChannelId}>\n` +
        `Checkpoint: ${r.checkpointUsed ? 'yes' : 'no'} | Messages injected: ${r.messagesInjected}`
      );
    } else {
      await reply.edit(`Failed to resume: ${data.error}`);
    }
  } catch (err: any) {
    await reply.edit(`Failed to resume: ${err.message}`);
  }
}

async function handleMode(message: any, args: string[]): Promise<void> {
  if (args.length < 1) {
    await message.reply(`Current global indicator mode: **${getGlobalIndicatorMode()}**\nUsage: \`/mode default <off|typing>\` or \`/mode <session> <off|typing|reset>\``);
    return;
  }

  if (args[0] === 'default') {
    const mode = args[1] as IndicatorMode;
    if (mode !== 'off' && mode !== 'typing') {
      await message.reply('Usage: `/mode default <off|typing>`');
      return;
    }
    setGlobalIndicatorMode(mode);
    await message.reply(`✓ Global indicator mode set to **${mode}**`);
    return;
  }

  // Per-session: /mode <session> <off|typing|reset>
  const sessionName = args[0];
  const mode = args[1];
  const session = getSessionByName(sessionName);
  if (!session) {
    await message.reply(`Session "${sessionName}" not found.`);
    return;
  }

  if (mode === 'reset') {
    updateSessionIndicatorMode(session.id, null);
    await message.reply(`✓ Session **${sessionName}** indicator mode reset to global default (**${getGlobalIndicatorMode()}**)`);
  } else if (mode === 'off' || mode === 'typing') {
    updateSessionIndicatorMode(session.id, mode);
    await message.reply(`✓ Session **${sessionName}** indicator mode set to **${mode}**`);
  } else {
    await message.reply('Usage: `/mode <session> <off|typing|reset>`');
  }
}

async function handleSessionMode(message: any, session: Session): Promise<void> {
  const parts = message.content.trim().split(/\s+/);
  const mode = parts[1];

  if (!mode) {
    const current = session.indicatorMode || `inherited (${getGlobalIndicatorMode()})`;
    await message.reply(`Indicator mode: **${current}**\nUsage: \`/mode <off|typing|reset>\``);
    return;
  }

  if (mode === 'reset') {
    updateSessionIndicatorMode(session.id, null);
    await message.reply(`✓ Indicator mode reset to global default (**${getGlobalIndicatorMode()}**)`);
  } else if (mode === 'off' || mode === 'typing') {
    updateSessionIndicatorMode(session.id, mode);
    await message.reply(`✓ Indicator mode set to **${mode}**`);
  } else {
    await message.reply('Usage: `/mode <off|typing|reset>`');
  }
}

async function handleHelp(message: any): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle('Conductor Commands')
    .setColor(0x5865f2)
    .addFields(
      { name: '/new <name> [dir]', value: 'Start a new Claude Code session. Creates a Discord channel and tmux session.', inline: false },
      { name: '/list', value: 'List all sessions with status.', inline: false },
      { name: '/kill <name>', value: 'Kill a session (with confirmation).', inline: false },
      { name: '/resume [name]', value: 'Resume an interrupted session, or list interrupted sessions.', inline: false },
      { name: '/mode default <off|typing>', value: 'Set the global typing indicator mode.', inline: false },
      { name: '/mode <session> <off|typing|reset>', value: 'Set per-session typing indicator (reset = inherit global).', inline: false },
      { name: '/help', value: 'Show this help.', inline: false },
    );

  await message.reply({ embeds: [embed] });
}

function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

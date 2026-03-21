import {
  Client, GatewayIntentBits, TextChannel, ChannelType,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ComponentType,
} from 'discord.js';
import type { AddDirResult, Session, DaemonResponse, ResumeResult } from './types.js';
import { getSessionByChannelId, getSessionByName, getInterruptedSessions, updateSessionIndicatorMode } from './sessions.js';
import { sendToSession, getGlobalIndicatorMode, setGlobalIndicatorMode } from './bridge.js';
import type { IndicatorMode } from './types.js';
import { logger } from './logger.js';
import { formatCommand, parseCommand } from './command-prefix.js';

const API_BASE = () => `http://localhost:${process.env.CONDUCTOR_API_PORT || '7842'}`;
const DISCORD_MESSAGE_LIMIT = 2000;

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
  const orchTopic = `Conductor control plane — use ${formatCommand('new')}, ${formatCommand('list')}, ${formatCommand('kill')}, ${formatCommand('resume')}, ${formatCommand('help')}`;
  let orchChannel = guild.channels.cache.find(
    c => c.name === orchName && c.parentId === category!.id && c.type === ChannelType.GuildText
  ) as TextChannel | undefined;

  if (!orchChannel) {
    orchChannel = await guild.channels.create({
      name: orchName,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: orchTopic,
    }) as TextChannel;
    logger.info(`Created #${orchName} channel`);
  } else if (orchChannel.topic !== orchTopic) {
    await orchChannel.setTopic(orchTopic);
  }

  // Post startup message
  await orchChannel.send(
    `✓ Conductor is online. Use \`${formatCommand('new <session-name> [<project-dir>]')}\` to start a session.`
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
      const command = parseCommand(message.content);
      if (command?.name === 'mode') {
        await handleSessionMode(message, session, command.args);
        return;
      }
      if (command?.name === 'add-dir') {
        await handleSessionAddDir(message, session, command.args);
        return;
      }
      // Relay to Claude Code
      if (session.status === 'active' || session.status === 'starting') {
        const ok = await sendToSession(session, message.content, client);
        if (!ok) {
          await message.reply('This session is currently unavailable. The worker or structured channel transport is disconnected.');
        }
      }
    }
  });
}

async function handleOrchestratorCommand(message: any): Promise<void> {
  const command = parseCommand(message.content);
  if (!command) return;

  try {
    switch (command.name) {
      case 'new':
        await handleNew(message, command.args);
        break;
      case 'list':
        await handleList(message);
        break;
      case 'kill':
        await handleKill(message, command.args);
        break;
      case 'resume':
        await handleResume(message, command.args);
        break;
      case 'add-dir':
        await handleAddDir(message, command.args);
        break;
      case 'mode':
        await handleMode(message, command.args);
        break;
      case 'help':
        await handleHelp(message);
        break;
      default:
        await message.reply(`Unknown command: ${formatCommand(command.name)}. Use \`${formatCommand('help')}\` for available commands.`);
    }
  } catch (err: any) {
    logger.error(`Command handler error: ${err.message}`);
    await message.reply(`Error: ${err.message}`).catch(() => {});
  }
}

async function handleNew(message: any, args: string[]): Promise<void> {
  if (args.length < 1) {
    await message.reply(`Usage: \`${formatCommand('new <name> [dir]')}\``);
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
      await editReplyContent(reply, `✓ Session **${name}** is live → <#${data.data.discordChannelId}>`);
    } else {
      await editReplyContent(reply, `Failed to start session: ${data.error}`);
    }
  } catch (err: any) {
    await editReplyContent(reply, `Failed to start session: ${err.message}`);
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
    await message.reply(`Usage: \`${formatCommand('kill <name>')}\``);
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
      await message.reply(`No interrupted sessions to resume. Usage: \`${formatCommand('resume <name>')}\``);
      return;
    }
    const names = interrupted.map(s => `  • **${s.name}** (interrupted ${formatDuration(Date.now() - (s.interruptedAt || s.lastActiveAt))} ago)`);
    await message.reply(`Interrupted sessions:\n${names.join('\n')}\n\nUse \`${formatCommand('resume <name>')}\` to resume.`);
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
      await editReplyContent(
        reply,
        `↺ Session **${name}** resumed (resume #${r.session.resumeCount}) → <#${r.session.discordChannelId}>\n` +
        `Checkpoint: ${r.checkpointUsed ? 'yes' : 'no'} | Messages injected: ${r.messagesInjected}`
      );
    } else {
      await editReplyContent(reply, `Failed to resume: ${data.error}`);
    }
  } catch (err: any) {
    await editReplyContent(reply, `Failed to resume: ${err.message}`);
  }
}

async function handleAddDir(message: any, args: string[]): Promise<void> {
  if (args.length < 2) {
    await message.reply(`Usage: \`${formatCommand('add-dir <session> <path>')}\``);
    return;
  }

  const name = args[0];
  const dir = args.slice(1).join(' ').trim();
  const session = getSessionByName(name);
  if (!session) {
    await message.reply(`Session "${name}" not found.`);
    return;
  }

  await applyAdditionalDirectory(message, session, dir);
}

async function handleMode(message: any, args: string[]): Promise<void> {
  if (args.length < 1) {
    await message.reply(
      `Current global indicator mode: **${getGlobalIndicatorMode()}**\n` +
      `Usage: \`${formatCommand('mode default <off|typing>')}\` or \`${formatCommand('mode <session> <off|typing|reset>')}\``
    );
    return;
  }

  if (args[0] === 'default') {
    const mode = args[1] as IndicatorMode;
    if (mode !== 'off' && mode !== 'typing') {
      await message.reply(`Usage: \`${formatCommand('mode default <off|typing>')}\``);
      return;
    }
    setGlobalIndicatorMode(mode);
    await message.reply(`✓ Global indicator mode set to **${mode}**`);
    return;
  }

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
    await message.reply(`Usage: \`${formatCommand('mode <session> <off|typing|reset>')}\``);
  }
}

async function handleSessionMode(message: any, session: Session, args: string[]): Promise<void> {
  const mode = args[0];

  if (!mode) {
    const current = session.indicatorMode || `inherited (${getGlobalIndicatorMode()})`;
    await message.reply(`Indicator mode: **${current}**\nUsage: \`${formatCommand('mode <off|typing|reset>')}\``);
    return;
  }

  if (mode === 'reset') {
    updateSessionIndicatorMode(session.id, null);
    await message.reply(`✓ Indicator mode reset to global default (**${getGlobalIndicatorMode()}**)`);
  } else if (mode === 'off' || mode === 'typing') {
    updateSessionIndicatorMode(session.id, mode);
    await message.reply(`✓ Indicator mode set to **${mode}**`);
  } else {
    await message.reply(`Usage: \`${formatCommand('mode <off|typing|reset>')}\``);
  }
}

async function handleSessionAddDir(message: any, session: Session, args: string[]): Promise<void> {
  const dir = args.join(' ').trim();
  if (!dir) {
    await message.reply(`Usage: \`${formatCommand('add-dir <path>')}\``);
    return;
  }

  await applyAdditionalDirectory(message, session, dir);
}

async function handleHelp(message: any): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle('Conductor Commands')
    .setColor(0x5865f2)
    .addFields(
      { name: formatCommand('new <name> [dir]'), value: 'Start a new Claude Code session. Creates a Discord channel and launches a detached worker.', inline: false },
      { name: formatCommand('list'), value: 'List all sessions with status.', inline: false },
      { name: formatCommand('kill <name>'), value: 'Kill a session (with confirmation).', inline: false },
      { name: formatCommand('resume [name]'), value: 'Resume an interrupted session, or list interrupted sessions.', inline: false },
      { name: formatCommand('add-dir <session> <path>'), value: 'Allow an extra directory for a session and restart it to apply the new access.', inline: false },
      { name: formatCommand('mode default <off|typing>'), value: 'Set the global typing indicator mode.', inline: false },
      { name: formatCommand('mode <session> <off|typing|reset>'), value: 'Set per-session typing indicator (reset = inherit global).', inline: false },
      { name: formatCommand('help'), value: 'Show this help.', inline: false },
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

async function applyAdditionalDirectory(message: any, session: Session, dir: string): Promise<void> {
  if (!dir) {
    await message.reply('Directory path is required.');
    return;
  }

  const reply = await message.reply(`Adding \`${dir}\` to session **${session.name}** and restarting it…`);

  try {
    const res = await fetch(`${API_BASE()}/sessions/${session.id}/add-dir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    });
    const data = await res.json() as DaemonResponse<AddDirResult>;
    if (data.ok && data.data) {
      await editReplyContent(
        reply,
        `✓ Added \`${data.data.addedDir}\` to session **${session.name}** and restarted it via **${data.data.resumeStrategy}** → <#${data.data.session.discordChannelId}>`
      );
    } else {
      await editReplyContent(reply, `Failed to add directory: ${data.error}`);
    }
  } catch (err: any) {
    await editReplyContent(reply, `Failed to add directory: ${err.message}`);
  }
}

async function editReplyContent(reply: any, content: string): Promise<void> {
  await reply.edit(truncateDiscordMessage(content));
}

function truncateDiscordMessage(content: string): string {
  if (content.length <= DISCORD_MESSAGE_LIMIT) {
    return content;
  }

  return `${content.slice(0, DISCORD_MESSAGE_LIMIT - 3)}...`;
}

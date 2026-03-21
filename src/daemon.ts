import express from 'express';
import fs from 'fs';
import path from 'path';
import { Client, TextChannel, ChannelType } from 'discord.js';
import { nanoid } from 'nanoid';
import type { Session, SpawnRequest, DaemonResponse } from './types.js';
import {
  createSession, getSession, getSessionByName, getAllSessions,
  getActiveSessions, updateSessionStatus, updateSessionActivity,
  deleteSession, markInterrupted,
} from './sessions.js';
import { createTmuxSession, sendKeys, sendEnter, sendTmuxRaw, killTmuxSession, tmuxSessionExists, getSessionPid, capturePaneOutput } from './tmux.js';
import { buildClaudeCommand } from './pairing.js';
import { resumeSession } from './resume.js';
import { startBridge, stopBridge } from './bridge.js';
import { logger } from './logger.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/;

let healthMonitorTimer: ReturnType<typeof setInterval> | null = null;

interface DaemonDeps {
  discordClient: Client;
  getConductorCategory: () => string | undefined;
}

export function createDaemon(deps: DaemonDeps): express.Express {
  const app = express();
  app.use(express.json());

  const { discordClient, getConductorCategory } = deps;

  // --- POST /sessions/spawn ---
  app.post('/sessions/spawn', async (req, res) => {
    try {
      const body = req.body as SpawnRequest;

      // Validate name
      if (!body.name || !NAME_RE.test(body.name)) {
        res.json({ ok: false, error: 'Name must be 2-32 chars, lowercase alphanumeric and hyphens only' } as DaemonResponse);
        return;
      }

      // Check duplicate
      if (getSessionByName(body.name)) {
        res.json({ ok: false, error: `Session "${body.name}" already exists` } as DaemonResponse);
        return;
      }

      // Check max sessions
      const maxSessions = parseInt(process.env.MAX_SESSIONS || '10', 10);
      const activeSessions = getActiveSessions();
      if (activeSessions.length >= maxSessions) {
        res.json({ ok: false, error: `Maximum sessions reached (${maxSessions})` } as DaemonResponse);
        return;
      }

      // Resolve project dir
      const defaultWorkDir = (process.env.DEFAULT_WORK_DIR || '~/projects').replace('~', process.env.HOME || '/root');
      const projectDir = body.projectDir
        ? path.resolve(body.projectDir.replace('~', process.env.HOME || '/root'))
        : path.join(defaultWorkDir, body.name);

      // Ensure project dir exists
      if (!fs.existsSync(projectDir)) {
        fs.mkdirSync(projectDir, { recursive: true });
        logger.info(`Created project directory: ${projectDir}`);
      }

      // Create Discord channel
      const guild = discordClient.guilds.cache.first();
      if (!guild) {
        res.json({ ok: false, error: 'Discord guild not found' } as DaemonResponse);
        return;
      }

      const categoryId = getConductorCategory();
      const channel = await guild.channels.create({
        name: body.name,
        type: ChannelType.GuildText,
        parent: categoryId,
        topic: `Claude Code session: ${body.name} | Dir: ${projectDir}`,
      });

      // Create session record
      const session: Session = {
        id: nanoid(8),
        name: body.name,
        discordChannelId: channel.id,
        discordChannelName: channel.name,
        tmuxSession: `conductor-${body.name}`,
        projectDir,
        pid: null,
        status: 'starting',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        lastCheckpointAt: null,
        checkpointPath: null,
        resumeCount: 0,
        interruptedAt: null,
      };
      createSession(session);

      // Spawn tmux session
      createTmuxSession(session.tmuxSession, session.projectDir);

      // Build and send the claude command
      const claudeCmd = buildClaudeCommand(session);
      sendKeys(session.tmuxSession, claudeCmd);

      // Wait for Claude Code to start, handle workspace trust prompt
      const startedAt = Date.now();
      const timeoutMs = 30_000;
      let ready = false;

      while (Date.now() - startedAt < timeoutMs) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const pane = capturePaneOutput(session.tmuxSession, 30);

        // Auto-accept workspace trust prompt ("Yes, I trust" is option 1, already selected)
        if (pane.includes('Yes, I trust this folder')) {
          sendEnter(session.tmuxSession);
          await new Promise(resolve => setTimeout(resolve, 3000));
          continue;
        }

        // Auto-accept bypass permissions prompt (need to select option 2 "Yes, I accept")
        if (pane.includes('Yes, I accept') && pane.includes('No, exit')) {
          sendTmuxRaw(session.tmuxSession, 'Down');
          await new Promise(resolve => setTimeout(resolve, 500));
          sendEnter(session.tmuxSession);
          await new Promise(resolve => setTimeout(resolve, 3000));
          continue;
        }

        // Check if Claude Code is at the prompt (❯) and NOT in a menu
        if (pane.includes('❯') && !pane.includes('Enter to confirm') && !pane.includes('Yes, I trust') && !pane.includes('Yes, I accept')) {
          ready = true;
          break;
        }
      }

      // Update status and start the bridge
      const pid = getSessionPid(session.tmuxSession);
      updateSessionStatus(session.id, ready ? 'active' : 'starting', pid ?? undefined);

      if (ready) {
        startBridge(session, discordClient);
        await channel.send(`✓ Session **${session.name}** is live. Claude Code is running in \`${session.projectDir}\`.`);
      }

      const updated = getSession(session.id)!;
      res.json({ ok: true, data: updated } as DaemonResponse<Session>);
    } catch (err: any) {
      logger.error(`Spawn failed: ${err.message}`);
      res.json({ ok: false, error: err.message } as DaemonResponse);
    }
  });

  // --- DELETE /sessions/:id ---
  app.delete('/sessions/:id', async (req, res) => {
    try {
      const session = getSession(req.params.id);
      if (!session) {
        res.json({ ok: false, error: 'Session not found' } as DaemonResponse);
        return;
      }

      // Stop bridge and kill tmux session
      stopBridge(session.id);
      killTmuxSession(session.tmuxSession);

      // Handle Discord channel
      const archiveOnKill = process.env.ARCHIVE_ON_KILL !== 'false';
      try {
        const guild = discordClient.guilds.cache.first();
        const channel = guild?.channels.cache.get(session.discordChannelId);
        if (channel) {
          if (archiveOnKill) {
            // Archive: rename and optionally move to archive category
            const textChannel = channel as TextChannel;
            await textChannel.setName(`archive-${session.name}`);
            await textChannel.send(`⚠ Session **${session.name}** has been killed and archived.`);

            // Try to find or create an Archive category
            if (guild) {
              let archiveCat = guild.channels.cache.find(
                c => c.name === 'Archive' && c.type === ChannelType.GuildCategory
              );
              if (!archiveCat) {
                archiveCat = await guild.channels.create({
                  name: 'Archive',
                  type: ChannelType.GuildCategory,
                });
              }
              await textChannel.setParent(archiveCat.id);
            }
          } else {
            await channel.delete();
          }
        }
      } catch (err: any) {
        logger.error(`Failed to handle Discord channel for ${session.name}: ${err.message}`);
      }

      deleteSession(session.id);
      res.json({ ok: true } as DaemonResponse);
    } catch (err: any) {
      logger.error(`Delete failed: ${err.message}`);
      res.json({ ok: false, error: err.message } as DaemonResponse);
    }
  });

  // --- GET /sessions ---
  app.get('/sessions', (_req, res) => {
    try {
      const sessions = getAllSessions();
      // Live status check
      for (const session of sessions) {
        if (session.status === 'active' || session.status === 'starting') {
          if (!tmuxSessionExists(session.tmuxSession)) {
            markInterrupted(session.id);
            session.status = 'interrupted';
          }
        }
      }
      res.json({ ok: true, data: sessions } as DaemonResponse<Session[]>);
    } catch (err: any) {
      res.json({ ok: false, error: err.message } as DaemonResponse);
    }
  });

  // --- GET /sessions/:id ---
  app.get('/sessions/:id', (req, res) => {
    try {
      const session = getSession(req.params.id);
      if (!session) {
        res.json({ ok: false, error: 'Session not found' } as DaemonResponse);
        return;
      }
      res.json({ ok: true, data: session } as DaemonResponse<Session>);
    } catch (err: any) {
      res.json({ ok: false, error: err.message } as DaemonResponse);
    }
  });

  // --- POST /sessions/:id/ping ---
  app.post('/sessions/:id/ping', (req, res) => {
    try {
      const session = getSession(req.params.id);
      if (!session) {
        res.json({ ok: false, error: 'Session not found' } as DaemonResponse);
        return;
      }
      updateSessionActivity(session.id);
      res.json({ ok: true } as DaemonResponse);
    } catch (err: any) {
      res.json({ ok: false, error: err.message } as DaemonResponse);
    }
  });

  // --- POST /sessions/:id/resume ---
  app.post('/sessions/:id/resume', async (req, res) => {
    try {
      const session = getSession(req.params.id);
      if (!session) {
        res.json({ ok: false, error: 'Session not found' } as DaemonResponse);
        return;
      }
      if (session.status !== 'interrupted') {
        res.json({ ok: false, error: `Session is ${session.status}, not interrupted` } as DaemonResponse);
        return;
      }
      const result = await resumeSession(session, discordClient);
      res.json({ ok: true, data: result } as DaemonResponse);
    } catch (err: any) {
      logger.error(`Resume failed: ${err.message}`);
      res.json({ ok: false, error: err.message } as DaemonResponse);
    }
  });

  return app;
}

export function startHealthMonitor(discordClient: Client): void {
  healthMonitorTimer = setInterval(async () => {
    const sessions = getAllSessions();
    const idleTimeoutMins = parseInt(process.env.SESSION_IDLE_TIMEOUT_MINS || '120', 10);

    for (const session of sessions) {
      if (session.status !== 'active' && session.status !== 'starting' && session.status !== 'idle') {
        continue;
      }

      // Check if tmux session is still alive
      if (!tmuxSessionExists(session.tmuxSession)) {
        logger.warn(`Session ${session.name}: tmux session gone — marking interrupted`);
        markInterrupted(session.id);

        try {
          const channel = await discordClient.channels.fetch(session.discordChannelId) as TextChannel | null;
          if (channel) {
            await channel.send(`⚠ Session **${session.name}** has been interrupted (process exited). Use \`/resume ${session.name}\` in #orchestrator to recover.`);
          }
        } catch {
          // Best effort
        }
        continue;
      }

      // Check idle timeout
      if (idleTimeoutMins > 0) {
        const idleMs = Date.now() - session.lastActiveAt;
        const idleMins = idleMs / 60_000;

        if (idleMins >= idleTimeoutMins) {
          logger.info(`Session ${session.name}: idle for ${Math.round(idleMins)} minutes — killing`);

          try {
            const channel = await discordClient.channels.fetch(session.discordChannelId) as TextChannel | null;
            if (channel) {
              await channel.send(`⚠ This session has been idle for ${Math.round(idleMins)} minutes and will be closed.`);
            }
          } catch {
            // Best effort
          }

          killTmuxSession(session.tmuxSession);
          updateSessionStatus(session.id, 'dead');
        }
      }
    }
  }, 60_000);
}

export function stopHealthMonitor(): void {
  if (healthMonitorTimer) {
    clearInterval(healthMonitorTimer);
    healthMonitorTimer = null;
  }
}

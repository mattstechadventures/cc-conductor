import 'dotenv/config';
import { TextChannel } from 'discord.js';
import { initDb, closeDb, getActiveSessions } from './sessions.js';
import { createDiscordClient, setupBot, getConductorCategory } from './bot.js';
import { createDaemon, startHealthMonitor, stopHealthMonitor } from './daemon.js';
import { reconcileOnStartup } from './resume.js';
import { startCheckpointScheduler, stopCheckpointScheduler, flushAllCheckpoints } from './checkpoint.js';
import { killTmuxSession } from './tmux.js';
import { stopAllBridges } from './bridge.js';
import { logger } from './logger.js';

// Validate required env vars
const REQUIRED_VARS = ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID'];
for (const v of REQUIRED_VARS) {
  if (!process.env[v]) {
    logger.error(`Missing required environment variable: ${v}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  logger.info('Conductor starting...');

  // 1. Initialize database
  initDb();

  // 2. Create and login Discord client
  const client = createDiscordClient();

  await new Promise<void>((resolve, reject) => {
    client.once('ready', () => {
      logger.info(`Discord bot logged in as ${client.user?.tag}`);
      resolve();
    });
    client.once('error', reject);
    client.login(process.env.DISCORD_BOT_TOKEN);
  });

  // 3. Setup bot (create channels, register handlers)
  await setupBot(client);

  // 4. Reconcile sessions on startup
  const report = await reconcileOnStartup(client);
  logger.info('Startup reconciliation:', report);

  // 5. Auto-resume if configured
  if (process.env.AUTO_RESUME_ON_START === 'true' && report.interrupted.length > 0) {
    logger.info(`Auto-resuming ${report.interrupted.length} interrupted sessions...`);
    // Resume is handled via the daemon API, which we're about to start
    // We'll trigger resumes after the daemon is up
  }

  // 6. Start Express daemon
  const port = parseInt(process.env.CONDUCTOR_API_PORT || '7842', 10);
  const daemon = createDaemon({
    discordClient: client,
    getConductorCategory,
  });

  const server = daemon.listen(port, '127.0.0.1', () => {
    logger.info(`Daemon listening on 127.0.0.1:${port}`);
  });

  // 7. Auto-resume interrupted sessions if configured
  if (process.env.AUTO_RESUME_ON_START === 'true' && report.interrupted.length > 0) {
    for (const name of report.interrupted) {
      try {
        const res = await fetch(`http://localhost:${port}/sessions/spawn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        logger.info(`Auto-resume request for ${name}:`, await res.json());
      } catch (err: any) {
        logger.error(`Auto-resume failed for ${name}: ${err.message}`);
      }
    }
  }

  // 8. Start health monitor
  startHealthMonitor(client);

  // 9. Start checkpoint scheduler
  startCheckpointScheduler(() => getActiveSessions(), client);

  // 10. Graceful shutdown handler
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal} — shutting down...`);

    // Post offline message
    try {
      const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID!);
      if (guild) {
        const orchName = process.env.ORCHESTRATOR_CHANNEL_NAME || 'orchestrator';
        const orchChannel = guild.channels.cache.find(
          c => c.name === orchName && c.isTextBased()
        ) as TextChannel | undefined;
        if (orchChannel) {
          await orchChannel.send('Conductor is going offline.');
        }
      }
    } catch {
      // Best effort
    }

    // Flush checkpoints
    try {
      const activeSessions = getActiveSessions();
      if (activeSessions.length > 0) {
        logger.info(`Flushing checkpoints for ${activeSessions.length} active sessions...`);
        await flushAllCheckpoints(activeSessions, client);
      }
    } catch {
      // Best effort
    }

    // Stop timers and bridges
    stopHealthMonitor();
    stopCheckpointScheduler();
    stopAllBridges();

    // Kill all active tmux sessions
    const activeSessions = getActiveSessions();
    for (const s of activeSessions) {
      killTmuxSession(s.tmuxSession);
    }

    // Close resources
    server.close();
    closeDb();
    client.destroy();

    logger.info('Conductor shut down cleanly.');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('Conductor is fully operational.');
}

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  process.exit(1);
});

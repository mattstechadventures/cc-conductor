import 'dotenv/config';
import { TextChannel } from 'discord.js';
import { createDiscordClient, getConductorCategory, setupBot } from './bot.js';
import { getBackendAdapter, getBackendDisplayName, parseEnabledAgentBackends } from './agent-backends.js';
import { stopAllBridges } from './bridge.js';
import { flushAllCheckpoints, startCheckpointScheduler, stopCheckpointScheduler } from './checkpoint.js';
import { createDaemon, startHealthMonitor, stopHealthMonitor } from './daemon.js';
import { logger } from './logger.js';
import { getRuntimeBuildId } from './runtime-build.js';
import { reconcileOnStartup } from './resume.js';
import { closeDb, getActiveSessions, getSessionByName, initDb } from './sessions.js';
import { waitForWorkerRegistrations } from './runtime-state.js';

const REQUIRED_VARS = ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID'];

for (const variable of REQUIRED_VARS) {
  if (!process.env[variable]) {
    logger.error(`Missing required environment variable: ${variable}`);
    process.exit(1);
  }
}

function formatStartupError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);

  if (process.platform === 'win32' && /not a valid Win32 application/i.test(message)) {
    return `${message}\n\nThis usually means node_modules was installed on a different OS, such as WSL/Linux, and is being reused on Windows.\nReinstall dependencies from PowerShell in this repo:\n  Remove-Item -Recurse -Force node_modules\n  npm install`;
  }

  return message;
}

async function main(): Promise<void> {
  logger.info('CC Conductor starting...');
  process.env.CONDUCTOR_RUNTIME_BUILD_ID = getRuntimeBuildId();
  initDb();
  for (const backend of parseEnabledAgentBackends()) {
    const validation = getBackendAdapter(backend).validate(process.env) as {
      resolvedPath: string;
      versionText?: string;
    };
    if (backend === 'claude') {
      process.env.CONDUCTOR_RESOLVED_CLAUDE_BIN = validation.resolvedPath;
    } else if (backend === 'codex') {
      process.env.CONDUCTOR_RESOLVED_CODEX_BIN = validation.resolvedPath;
    }
    logger.info(
      `Validated ${getBackendDisplayName(backend)} ${validation.versionText || ''} at ${validation.resolvedPath}`.trim()
    );
  }

  const client = createDiscordClient();
  await new Promise<void>((resolve, reject) => {
    client.once('clientReady', () => resolve());
    client.once('error', reject);
    void client.login(process.env.DISCORD_BOT_TOKEN);
  });

  logger.info(`Discord bot logged in as ${client.user?.tag}`);
  await setupBot(client);

  const port = parseInt(process.env.CONDUCTOR_API_PORT || '7842', 10);
  const daemon = createDaemon({
    discordClient: client,
    getConductorCategory,
  });

  const server = daemon.listen(port, '127.0.0.1', () => {
    logger.info(`Daemon listening on 127.0.0.1:${port}`);
  });

  const reconnectGraceMs = parseInt(process.env.SESSION_RECONNECT_GRACE_MS || '15000', 10);
  await waitForWorkerRegistrations(getActiveSessions().map(session => session.id), reconnectGraceMs);

  const report = await reconcileOnStartup(client);
  logger.info('Startup reconciliation', report);

  if (process.env.AUTO_RESUME_ON_START === 'true' && report.interrupted.length > 0) {
    for (const sessionName of report.interrupted) {
      const session = getSessionByName(sessionName);
      if (!session) continue;
      try {
        await fetch(`http://127.0.0.1:${port}/sessions/${session.id}/resume`, {
          method: 'POST',
        });
      } catch (err: any) {
        logger.error(`Auto-resume failed for ${sessionName}: ${err.message}`);
      }
    }
  }

  startHealthMonitor(client);
  startCheckpointScheduler(() => getActiveSessions(), client);

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}; shutting down daemon without terminating session workers...`);

    try {
      const guild = client.guilds.cache.get(process.env.DISCORD_GUILD_ID!);
      if (guild) {
        const orchestratorName = process.env.ORCHESTRATOR_CHANNEL_NAME || 'orchestrator';
        const channel = guild.channels.cache.find(
          entry => entry.name === orchestratorName && entry.isTextBased()
        ) as TextChannel | undefined;
        if (channel) {
          await channel.send('CC Conductor is going offline. Existing session workers will continue running and reconnect when the daemon returns.');
        }
      }
    } catch {
      // best effort
    }

    try {
      const activeSessions = getActiveSessions();
      if (activeSessions.length > 0) {
        await flushAllCheckpoints(activeSessions, client);
      }
    } catch {
      // best effort
    }

    stopHealthMonitor();
    stopCheckpointScheduler();
    stopAllBridges();
    server.close();
    closeDb();
    client.destroy();
    process.exit(0);
  }

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  logger.info('CC Conductor is fully operational.');
}

main().catch((err) => {
  logger.error(`Fatal error: ${formatStartupError(err)}`);
  process.exit(1);
});

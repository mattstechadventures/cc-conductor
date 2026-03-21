# Conductor — Claude Code Session Orchestrator

A self-hosted system that turns a Discord server into a multi-session Claude Code hub. Post a command in a control channel, and Conductor spawns a Claude Code session on your server, creates a matching Discord channel, and bridges them — so the Discord channel becomes a live two-way terminal to that Claude Code session.

## Prerequisites

- **Node.js 20+**
- **tmux** (installed and on PATH)
- **Claude Code v2.1.80+** (authenticated — run `claude` once manually first)
- **Bun** (for the channels plugin)
- A **Discord bot** with the correct permissions and intents (see below)

## Discord Bot Setup

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application and add a Bot
3. Enable these **Privileged Gateway Intents**:
   - Message Content Intent
4. Bot permissions required:
   - Manage Channels
   - Manage Messages
   - Read Messages / View Channels
   - Send Messages
   - Embed Links
   - Attach Files
5. Invite the bot to your server with an OAuth2 URL using the `bot` scope and the permissions above

## Installation

```bash
git clone <repo-url> conductor
cd conductor
npm install
cd plugin/discord-autopair && npm install && cd ../..
cp .env.example .env
# Edit .env with your Discord bot token, client ID, and guild ID
```

## Running

**Development:**
```bash
npm run dev
```

**Production (systemd — Linux):**
```bash
# Edit scripts/conductor.service paths as needed
sudo cp scripts/conductor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now conductor
```

**Production (launchd — macOS):**
```bash
# Edit scripts/com.conductor.plist paths as needed
cp scripts/com.conductor.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.conductor.plist
```

## Command Reference

All commands are typed in the `#orchestrator` channel:

| Command | Description |
|---------|-------------|
| `/new <name> [dir]` | Start a new Claude Code session. Creates a Discord channel and tmux session. |
| `/list` | List all sessions with status indicators. |
| `/kill <name>` | Kill a session (with confirmation button). |
| `/resume [name]` | Resume an interrupted session, or list resumable sessions. |
| `/help` | Show command reference. |

## Architecture

Conductor is a Node.js daemon that manages Claude Code sessions via tmux. The Discord bot handles the control plane (spawning, listing, killing sessions), while a forked Claude Code channels plugin handles the data plane (bridging Discord messages to/from each Claude Code session). Session state is persisted in SQLite, and periodic checkpoints capture git state and conversation history to enable session resumability across process crashes and system reboots.

## Environment Variables

See `.env.example` for all configuration options.

## Session Resumability

Conductor handles three failure modes:

1. **Conductor crash** (server still up): tmux sessions survive. On restart, Conductor reconciles its DB against live tmux sessions and re-attaches.
2. **Claude Code crash** (Conductor still up): The health monitor detects the dead process and marks the session as interrupted. Use `/resume <name>` to restart with context from the checkpoint file and Discord history.
3. **Full system restart**: All tmux sessions are gone. On startup, Conductor detects interrupted sessions and notifies in each channel. Use `/resume <name>` to reconstruct with injected context.

## Known Limitations

- **Research preview:** The `--dangerously-load-development-channels` flag is required for the custom plugin. This is a Claude Code research preview feature.
- **Single guild:** Conductor manages one Discord server only, set by `DISCORD_GUILD_ID`.
- **Claude Code auth:** Claude Code must be pre-authenticated on the server. Conductor does not handle login.
- **No inbound ports:** The daemon listens on localhost only. The plugin communicates with Discord via outbound API calls.
- **Bun required:** The channels plugin runs under Bun (Claude Code plugin format requirement). The main process uses Node.js.

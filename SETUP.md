# Conductor — Setup Guide

This guide walks through setting up Conductor from scratch. It's written so that either a human or Claude Code can follow it step-by-step.

---

## 1. System Prerequisites

Install the following before proceeding:

| Dependency | Minimum Version | Check Command | Install (macOS) | Install (Linux) |
|------------|----------------|---------------|-----------------|-----------------|
| Node.js | 20.0.0 | `node -v` | `brew install node` | [nodesource](https://github.com/nodesource/distributions) |
| tmux | any | `tmux -V` | `brew install tmux` | `apt install tmux` / `dnf install tmux` |
| Claude Code | v2.1.80+ | `claude --version` | `npm install -g @anthropic-ai/claude-code` | same |
| Bun | any | `bun -v` | `brew install oven-sh/bun/bun` | `curl -fsSL https://bun.sh/install \| bash` |

### Claude Code Authentication

Claude Code must be authenticated before Conductor can use it. Run `claude` once manually in a terminal, complete the login flow, and verify it reaches a working prompt. Conductor does not handle authentication.

---

## 2. Discord Bot Setup

### 2a. Create the Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**, give it a name (e.g. "Conductor")
3. Go to the **Bot** tab and click **Add Bot**
4. Copy the **Bot Token** — you'll need this for `.env`

### 2b. Enable Intents

On the **Bot** tab, scroll to **Privileged Gateway Intents** and enable:

- [x] **Message Content Intent**

### 2c. Set Permissions

The bot needs these permissions:

- Manage Channels
- Manage Messages
- Read Messages / View Channels
- Send Messages
- Embed Links
- Attach Files

### 2d. Invite the Bot

1. Go to the **OAuth2 → URL Generator** tab
2. Select scope: **bot**
3. Select the permissions listed above
4. Copy the generated URL and open it in a browser
5. Select your server and authorize

### 2e. Get IDs

You'll need three values for `.env`:

| Value | Where to Find It |
|-------|-----------------|
| `DISCORD_BOT_TOKEN` | Bot tab → Token (copied in 2a) |
| `DISCORD_CLIENT_ID` | OAuth2 tab → Client ID (or General Information → Application ID) |
| `DISCORD_GUILD_ID` | Right-click your server name in Discord → Copy Server ID (enable Developer Mode in Discord Settings → Advanced first) |

---

## 3. Install Conductor

```bash
# Clone the repository
git clone <repo-url> conductor
cd conductor

# Install Node.js dependencies
npm install

# Install MCP plugin dependencies (optional, backup bridge)
cd plugin/discord-autopair && npm install && cd ../..
```

---

## 4. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and fill in the three required values:

```env
# REQUIRED — fill these in
DISCORD_BOT_TOKEN=your-bot-token-here
DISCORD_CLIENT_ID=your-client-id-here
DISCORD_GUILD_ID=your-guild-id-here
```

### Optional Configuration

These have sensible defaults but can be tuned:

```env
# Channel name for the command interface (default: orchestrator)
ORCHESTRATOR_CHANNEL_NAME=orchestrator

# Local API port — only binds to 127.0.0.1 (default: 7842)
CONDUCTOR_API_PORT=7842

# Base directory for session working directories (default: ~/projects)
DEFAULT_WORK_DIR=~/projects

# Maximum concurrent sessions (default: 10)
MAX_SESSIONS=10

# Path to claude binary — defaults to 'claude' on PATH (default: claude)
# Set this if claude is installed somewhere not on PATH
CLAUDE_BIN=claude

# Kill sessions idle for this many minutes, 0 to disable (default: 120)
SESSION_IDLE_TIMEOUT_MINS=120

# Checkpoint interval in minutes (default: 15)
CHECKPOINT_INTERVAL_MINS=15

# Number of Discord messages to include in checkpoints (default: 50)
CHECKPOINT_DISCORD_MESSAGES=50

# Auto-resume interrupted sessions on daemon restart (default: false)
AUTO_RESUME_ON_START=false

# Move killed session channels to Archive category vs delete (default: true)
ARCHIVE_ON_KILL=true
```

---

## 5. Create the Working Directory

Make sure the directory specified by `DEFAULT_WORK_DIR` exists:

```bash
mkdir -p ~/projects
```

The `data/` directory (for SQLite) is created automatically on first run.

---

## 7. Run Conductor

### Development (foreground, with logs)

```bash
npm run dev
```

You should see:
```
[HH:MM:SS] Conductor starting...
[HH:MM:SS] Database initialized
[HH:MM:SS] Discord bot logged in as YourBot#1234
[HH:MM:SS] Daemon listening on 127.0.0.1:7842
[HH:MM:SS] Conductor is fully operational.
```

### Production — macOS (launchd)

1. Edit `scripts/com.conductor.plist`:
   - Update `WorkingDirectory` to your Conductor install path
   - Update the `node` path if yours differs (`which node`)

2. Install and start:
```bash
cp scripts/com.conductor.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.conductor.plist
```

3. Check logs:
```bash
tail -f /tmp/conductor.log
tail -f /tmp/conductor-error.log
```

4. Stop:
```bash
launchctl unload ~/Library/LaunchAgents/com.conductor.plist
```

### Production — Linux (systemd)

1. Edit `scripts/conductor.service`:
   - Update `WorkingDirectory` to your Conductor install path
   - Update `EnvironmentFile` path
   - Set the `User` if using template instantiation

2. Install and start:
```bash
sudo cp scripts/conductor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now conductor
```

3. Check logs:
```bash
journalctl -u conductor -f
```

---

## 8. Verify It Works

1. Open your Discord server
2. You should see a new **Conductor** category with a `#orchestrator` channel
3. In `#orchestrator`, type: `/help`
4. The bot should reply with available commands
5. Try: `/new test-session`
   - A new channel `#test-session` should appear
   - Claude Code should start in a tmux session
   - Messages you type in `#test-session` are relayed to Claude

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Missing required environment variable` | Check `.env` has all three required values filled in |
| Bot doesn't respond in Discord | Verify the bot is online (green dot). Check token is correct. Check Message Content Intent is enabled. |
| `claude: command not found` in tmux | Set `CLAUDE_BIN` in `.env` to the full path from `which claude` |
| `tmux: command not found` | Install tmux and ensure it's on PATH |
| Sessions spawn but no response | Check that Claude Code is authenticated — run `claude` manually first |
| Port 7842 already in use | Change `CONDUCTOR_API_PORT` in `.env`, or kill the existing process: `lsof -ti:7842 \| xargs kill` |
| Permission denied on database | Ensure the `data/` directory is writable by the user running Conductor |

---

## For Claude Code: Automated Setup Checklist

If you're Claude Code setting this up for a user, run through these steps:

1. **Check prerequisites**: `node -v`, `tmux -V`, `claude --version`, `bun -v`
2. **Install missing deps**: Use brew (macOS) or apt/dnf (Linux)
3. **Run `npm install`** in the project root
4. **Run `npm install`** in `plugin/discord-autopair/`
5. **Copy `.env.example` to `.env`** if `.env` doesn't exist
6. **Ask the user** for `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, and `DISCORD_GUILD_ID` — these cannot be guessed
7. **Set `CLAUDE_BIN`** in `.env` if `claude` isn't on PATH (use output of `which claude`)
8. **Create `DEFAULT_WORK_DIR`** (`mkdir -p ~/projects`)
9. **Run `npm run dev`** to verify startup
10. **Check Discord** for the `#orchestrator` channel and test `/help`

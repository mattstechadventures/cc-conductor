# Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` and fill in the required values.

## Required

| Variable | Description |
|----------|-------------|
| `DISCORD_BOT_TOKEN` | Bot token from the Discord Developer Portal |
| `DISCORD_CLIENT_ID` | Application client ID from Discord |
| `DISCORD_GUILD_ID` | Server (guild) ID where Conductor operates |

## Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCHESTRATOR_CHANNEL_NAME` | `orchestrator` | Name of the control channel where commands are issued |
| `CONDUCTOR_API_PORT` | `7842` | Port for the Express REST API (localhost only) |
| `DEFAULT_WORK_DIR` | `~/projects` | Base directory for session project directories. New sessions without an explicit dir get `<DEFAULT_WORK_DIR>/<session-name>` |
| `MAX_SESSIONS` | `10` | Maximum number of concurrent active sessions |
| `SESSION_IDLE_TIMEOUT_MINS` | `120` | Kill sessions idle longer than this (minutes). Set to `0` to disable |
| `CHECKPOINT_INTERVAL_MINS` | `15` | How often to write checkpoints (minutes). Set to `0` to disable |
| `CHECKPOINT_DISCORD_MESSAGES` | `50` | Number of recent Discord messages to include in checkpoints |
| `AUTO_RESUME_ON_START` | `false` | Automatically resume interrupted sessions when Conductor starts |
| `ARCHIVE_ON_KILL` | `true` | Archive killed session channels (`true`) or delete them (`false`) |
| `CLAUDE_BIN` | `claude` | Path to the Claude Code binary. Use an absolute path if Claude isn't on `$PATH` |
| `INDICATOR_MODE` | `typing` | Default typing indicator mode: `typing` (show "Conductor is typing...") or `off`. Can be overridden per-session with `/mode` |

## Discord Bot Setup

The bot requires these intents enabled in the Discord Developer Portal:
- **Server Members Intent** — not required
- **Message Content Intent** — required (for reading command and session messages)

Required bot permissions:
- Manage Channels (create/rename/delete/move session channels)
- Send Messages
- Read Message History
- Add Reactions

## Database

SQLite database is stored at `data/conductor.db` relative to the project root. Created automatically on first run. Uses WAL journal mode for concurrent read performance.

## Logging

Logs go to stdout in the format:
```
[2025-03-10 14:30:00] [INFO] Conductor starting...
```

Log levels: `DEBUG`, `INFO`, `WARN`, `ERROR`. No configuration for log level filtering — all levels are output.

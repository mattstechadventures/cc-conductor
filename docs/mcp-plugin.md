# MCP Plugin (Backup Bridge)

The MCP plugin at `plugin/discord-autopair/` is an alternative Discord bridge that uses the Model Context Protocol instead of tmux polling. It's a **backup/experimental** approach — the primary bridge is the tmux-based one in `src/bridge.ts`.

## How It Works

Instead of polling tmux output, the MCP plugin runs as a Claude Code plugin loaded via `--dangerously-load-development-channels`. It communicates with Claude Code through the MCP protocol:

- **Inbound:** Discord messages are forwarded to Claude via MCP notifications (`notifications/claude/channel`)
- **Outbound:** Claude calls the `reply` and `react` tools to send messages back to Discord

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | Discord bot token |
| `CONDUCTOR_CHANNEL_ID` | Yes | Discord channel ID to auto-pair to |
| `CONDUCTOR_SESSION_NAME` | No | Session name for status messages |
| `CONDUCTOR_PROJECT_DIR` | No | Project directory for status messages |
| `CONDUCTOR_RESUME_PROMPT_PATH` | No | Path to resume prompt file (injected on startup, then deleted) |

## Tools Provided

### `reply`
Send a message to the paired Discord channel.

```json
{
  "chat_id": "channel-id",
  "message": "Hello from Claude!"
}
```

Automatically splits messages exceeding Discord's 2000-character limit.

### `react`
Add an emoji reaction to a Discord message.

```json
{
  "chat_id": "channel-id",
  "message_id": "message-id",
  "emoji": "👍"
}
```

## Resume Support

If `CONDUCTOR_RESUME_PROMPT_PATH` is set and the file exists, the plugin injects its contents as the first MCP notification on startup, then deletes the file.

## Lifecycle

1. Discord client logs in and connects to the specified channel
2. MCP server connects via stdio transport
3. Posts a ready message: `✓ Session <name> is live.`
4. Listens for Discord messages and forwards to Claude
5. On shutdown (SIGTERM/SIGINT/beforeExit): posts "session ended" and disconnects

## Why It's a Backup

The MCP plugin requires `--dangerously-load-development-channels`, which is a research preview flag in Claude Code. The tmux bridge is more reliable and doesn't require experimental features. The plugin is kept as an alternative for cases where MCP-based communication is preferred.

## Running Standalone

```bash
cd plugin/discord-autopair
bun run server.ts
```

Requires Bun runtime and the MCP SDK dependency.

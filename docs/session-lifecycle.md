# Session Lifecycle

## States

```
starting → active → idle → dead
                ↘         ↗
              interrupted
                    ↓
                 (resume)
                    ↓
                starting → ...
```

| Status | Meaning |
|--------|---------|
| `starting` | tmux session created, Claude Code launching, waiting for prompt |
| `active` | Claude Code is at the prompt, bridge is running |
| `idle` | No messages for a while (tracked via `lastActiveAt`) |
| `interrupted` | tmux session died or Claude Code crashed |
| `dead` | Session was killed (idle timeout or `/kill`) |

## Spawn Flow

1. **Validate** — check name format, no duplicates, under `MAX_SESSIONS`
2. **Create project directory** — `mkdir -p` if it doesn't exist
3. **Create Discord channel** — text channel under the Conductor category, topic set to session info
4. **Create DB record** — session ID is `nanoid(8)`, status `starting`
5. **Create tmux session** — `tmux new-session -d -s conductor-<name> -c <projectDir>`
6. **Launch Claude Code** — `claude --permission-mode acceptEdits`
7. **Wait for prompt** (up to 30 seconds):
   - Auto-accept "Yes, I trust this folder" — sends Enter
   - Auto-accept "Yes, I accept" permission prompt — sends Down + Enter
   - Ready when `❯` appears without menu text
8. **Start bridge** — begin polling tmux pane
9. **Post ready message** — `✓ Session <name> is live.`

## Idle Tracking

Every message relayed through the bridge updates `lastActiveAt` via `updateSessionActivity()`. The ping endpoint (`POST /sessions/:id/ping`) also updates this timestamp.

The health monitor checks `lastActiveAt` every 60 seconds. If a session exceeds `SESSION_IDLE_TIMEOUT_MINS` (default 120), it is killed and set to `dead`.

## Termination

Sessions end in one of three ways:

### 1. User kills it (`/kill`)
- Confirmation button required
- Bridge stopped, tmux killed, channel archived/deleted, DB record removed

### 2. Idle timeout
- Health monitor detects idle time exceeding threshold
- Warning posted to Discord channel
- tmux session killed, status set to `dead`

### 3. Process crash (→ interrupted)
- Health monitor detects tmux session is gone
- Status set to `interrupted`, `interruptedAt` timestamp saved
- Warning posted to Discord channel with resume instructions
- Session can be recovered via `/resume`

## Channel Management

- Session channels are created under a "Conductor" category (auto-created on first startup)
- Channel topic is set to `Claude Code session: <name> | Dir: <projectDir>`
- On kill with `ARCHIVE_ON_KILL=true`: channel renamed to `archive-<name>`, moved to "Archive" category
- On kill with `ARCHIVE_ON_KILL=false`: channel deleted

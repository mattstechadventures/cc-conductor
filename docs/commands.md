# Discord Commands

All commands are issued in the **#orchestrator** channel (or whatever `ORCHESTRATOR_CHANNEL_NAME` is set to). Messages in session channels are relayed directly to Claude Code.

## `/new <name> [dir]`

Start a new Claude Code session.

- **name** — Session name. Must be 2-32 characters, lowercase alphanumeric and hyphens only, matching `/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/`.
- **dir** (optional) — Project directory path. Supports `~` expansion. If omitted, defaults to `$DEFAULT_WORK_DIR/<name>` (created if it doesn't exist).

**What happens:**
1. Creates a Discord text channel `#<name>` under the Conductor category
2. Creates a tmux session `conductor-<name>`
3. Launches `claude --permission-mode acceptEdits` in that tmux session
4. Auto-accepts workspace trust and permission prompts
5. Starts the message bridge
6. Posts a ready message with a link to the new channel

**Example:**
```
/new my-feature ~/dev/my-project
```

## `/list`

Show all sessions with their status.

Displays a Discord embed with:
- Status emoji: 🟢 active, 🟡 starting/idle, 🟠 interrupted, 🔴 dead
- Project directory
- Session age
- Time since last activity
- Resume count (if > 0)

The list also performs a live tmux check — if a tmux session has disappeared, it's marked interrupted on the spot.

## `/kill <name>`

Kill a session. Prompts for confirmation with a button (30-second timeout).

**On confirm:**
- Stops the message bridge
- Kills the tmux session
- Archives or deletes the Discord channel (controlled by `ARCHIVE_ON_KILL`)
  - Archive: renames to `archive-<name>` and moves to an "Archive" category
  - Delete: removes the channel entirely
- Removes the session from the database

## `/resume [name]`

Resume an interrupted session or list resumable sessions.

**Without arguments:** Lists all interrupted sessions with how long ago they were interrupted.

**With a session name:**
1. Reads the checkpoint file from the project directory
2. Fetches fresh Discord message history
3. Merges checkpoint and Discord messages (deduplicates by timestamp)
4. Builds a resume prompt with full context
5. Spawns a new Claude Code instance in the same tmux session
6. Injects the resume context
7. Posts a resume notice with metrics (checkpoint used, messages injected)

Only works on sessions with status `interrupted`.

## `/mode`

Control the Discord typing indicator ("Conductor is typing..."). Available in both the orchestrator and session channels.

**Orchestrator channel:**
- `/mode` — Show the current global indicator mode
- `/mode default <off|typing>` — Set the global default mode
- `/mode <session> <off|typing|reset>` — Set indicator mode for a specific session (`reset` clears the override and inherits the global default)

**Session channels:**
- `/mode` — Show the current mode for this session
- `/mode <off|typing|reset>` — Set indicator mode for this session

The `/mode` command is intercepted before relay — it is never sent to Claude Code.

**Fallback chain:** session DB value → global in-memory setting → `INDICATOR_MODE` env var → `typing`

## `/help`

Shows a Discord embed listing all available commands and their usage.

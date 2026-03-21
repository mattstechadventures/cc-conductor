# Checkpoints

Checkpoints periodically snapshot session state to disk, enabling recovery after crashes or restarts.

## Checkpoint File

Written to `<projectDir>/.conductor-checkpoint.json`:

```json
{
  "sessionId": "a1b2c3d4",
  "sessionName": "my-session",
  "projectDir": "/Users/matt/projects/my-session",
  "writtenAt": 1710000900000,
  "gitBranch": "feature/foo",
  "gitLastCommit": "abc1234 Add new feature",
  "taskSummary": "Working on implementing the search API endpoint...",
  "recentMessages": [
    {
      "author": "matt",
      "content": "add search to the API",
      "timestamp": 1710000060000
    },
    {
      "author": "claude",
      "content": "I've added a GET /search endpoint...",
      "timestamp": 1710000090000
    }
  ]
}
```

## What Gets Captured

### 1. Discord Messages
Fetches the most recent messages from the session's Discord channel (default 50, configurable via `CHECKPOINT_DISCORD_MESSAGES`). Messages are sorted chronologically. Bot messages are attributed to "claude", user messages use the display name.

### 2. Git State
Reads from the project directory:
- **Branch** — `git rev-parse --abbrev-ref HEAD`
- **Last commit** — `git log -1 --oneline`

Returns null for non-git directories.

### 3. Task Summary
Sends a prompt to Claude Code via tmux:
```
[CONDUCTOR_CHECKPOINT] Summarise in 2-3 sentences what you are currently working on or were last working on.
```
Waits 10 seconds, then captures the pane output and extracts Claude's response. This is best-effort — returns null if Claude doesn't respond in time.

## Scheduling

The checkpoint scheduler runs on an interval (default every 15 minutes, configurable via `CHECKPOINT_INTERVAL_MINS`). Set to 0 to disable.

On each tick, it writes checkpoints for all active sessions. Failures are logged but don't stop other sessions from being checkpointed.

## Flush on Shutdown

When Conductor receives SIGTERM/SIGINT, it flushes checkpoints for all active sessions before killing tmux sessions. This uses `Promise.allSettled` so individual failures don't block shutdown.

## Database Tracking

The `sessions` table tracks:
- `checkpoint_path` — path to the last checkpoint file
- `last_checkpoint_at` — timestamp of the last checkpoint

These are updated after each successful checkpoint write.

## Related

- [Resume & Recovery](resume-and-recovery.md) — how checkpoints are used during session resumption

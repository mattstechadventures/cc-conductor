# Health Monitoring

The health monitor runs as a background interval (every 60 seconds) that checks all active sessions for problems.

## What It Checks

For each session with status `active`, `starting`, or `idle`:

### 1. tmux Session Alive?

Calls `tmuxSessionExists()` (which runs `tmux has-session`). If the tmux session is gone:

- Marks the session as `interrupted` with current timestamp
- Posts a warning to the session's Discord channel:
  ```
  ⚠ Session my-session has been interrupted (process exited).
  Use /resume my-session in #orchestrator to recover.
  ```

### 2. Idle Timeout

If `SESSION_IDLE_TIMEOUT_MINS` > 0 (default: 120 minutes):

- Calculates idle time: `now - lastActiveAt`
- If idle time exceeds the threshold:
  - Posts a warning to the session's Discord channel:
    ```
    ⚠ This session has been idle for 125 minutes and will be closed.
    ```
  - Kills the tmux session
  - Sets status to `dead`

Set `SESSION_IDLE_TIMEOUT_MINS=0` to disable idle timeout entirely.

## Live Status Check on List

The `GET /sessions` endpoint also performs a live tmux check. When listing sessions, any `active` or `starting` session whose tmux session has disappeared is marked `interrupted` inline before returning results. This ensures the `/list` command always shows accurate status.

## Lifecycle

- **Start:** `startHealthMonitor(discordClient)` is called after the daemon starts
- **Stop:** `stopHealthMonitor()` is called during graceful shutdown

Both are managed in `src/index.ts`.

# Health Monitoring

The daemon checks active sessions every 60 seconds.

## Worker Health

The primary liveness signal is the worker heartbeat. If a worker is missing or stale beyond the configured threshold, the session is marked interrupted.

## Idle Timeout

If `SESSION_IDLE_TIMEOUT_MINS` is non-zero and the session exceeds that idle window:

- the daemon posts a warning to the Discord channel
- the worker is stopped
- the session is marked `dead`

## Transport Health

Channel connectivity is tracked separately from worker liveness. If the channel server disconnects, the session can temporarily fall back to PTY input while remaining alive.

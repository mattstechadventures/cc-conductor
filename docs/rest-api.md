# REST API

The Express daemon listens on `127.0.0.1:7842` (configurable via `CONDUCTOR_API_PORT`). All responses follow the `DaemonResponse<T>` format:

```json
{
  "ok": true,
  "data": { ... }
}
```

Or on error:

```json
{
  "ok": false,
  "error": "Description of what went wrong"
}
```

## Endpoints

### `POST /sessions/spawn`

Create a new session.

**Request body:**
```json
{
  "name": "my-session",
  "projectDir": "~/dev/my-project",
  "requestedBy": "discord-user-id"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | 2-32 chars, lowercase alphanumeric + hyphens |
| `projectDir` | No | Absolute or `~`-relative path. Defaults to `$DEFAULT_WORK_DIR/<name>` |
| `requestedBy` | Yes | Discord user ID of the requester |

**Validations:**
- Name must match `/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/`
- No duplicate session names
- Active session count must be below `MAX_SESSIONS`

**Response:** `DaemonResponse<Session>`

### `DELETE /sessions/:id`

Kill and clean up a session.

- Stops the bridge
- Kills the tmux session
- Archives or deletes the Discord channel (per `ARCHIVE_ON_KILL`)
- Removes the DB record

**Response:** `DaemonResponse`

### `GET /sessions`

List all sessions. Performs a live tmux check — sessions whose tmux process has disappeared are marked `interrupted` inline.

**Response:** `DaemonResponse<Session[]>`

### `GET /sessions/:id`

Get a single session by ID.

**Response:** `DaemonResponse<Session>`

### `POST /sessions/:id/ping`

Update a session's `lastActiveAt` timestamp. Used to prevent idle timeout.

**Response:** `DaemonResponse`

### `POST /sessions/:id/resume`

Resume an interrupted session. Only works if session status is `interrupted`.

Triggers the full resume flow: reads checkpoint, fetches Discord history, builds resume prompt, spawns new Claude Code instance.

**Response:** `DaemonResponse<ResumeResult>`

```json
{
  "ok": true,
  "data": {
    "session": { ... },
    "checkpointUsed": true,
    "messagesInjected": 42,
    "resumePromptLength": 3847
  }
}
```

## Session Object

```json
{
  "id": "a1b2c3d4",
  "name": "my-session",
  "discordChannelId": "123456789",
  "discordChannelName": "my-session",
  "tmuxSession": "conductor-my-session",
  "projectDir": "/Users/matt/projects/my-session",
  "pid": 12345,
  "status": "active",
  "createdAt": 1710000000000,
  "lastActiveAt": 1710000060000,
  "lastCheckpointAt": 1710000900000,
  "checkpointPath": "/Users/matt/projects/my-session/.conductor-checkpoint.json",
  "resumeCount": 0,
  "interruptedAt": null,
  "indicatorMode": null
}
```

**Status values:** `starting`, `active`, `idle`, `interrupted`, `dead`

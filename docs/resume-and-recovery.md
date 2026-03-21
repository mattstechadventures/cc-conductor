# Resume & Recovery

Conductor handles three failure modes, each with a different recovery path.

## Failure Modes

### Case 1: Conductor Crashed, Claude Still Running

The Conductor daemon restarted but the Claude Code process is still alive in its tmux session.

**Detection:** On startup, `reconcileOnStartup()` finds the tmux session exists and has a valid PID.

**Recovery:** `reattachSession()` reconnects by:
1. Updating the session status to `active` with the current PID
2. Posting a "Conductor restarted — session reconnected" notice to Discord

The Claude Code process never stopped, so no context is lost.

### Case 2: Claude Code Crashed, Conductor Still Running

The Claude Code process exited but Conductor is still healthy.

**Detection:** The health monitor (every 60 seconds) checks `tmuxSessionExists()`. When a session's tmux session disappears, it calls `markInterrupted()` and posts a warning to Discord.

**Recovery:** User runs `/resume <name>`, triggering `resumeSession()` (see full flow below).

### Case 3: Full System Restart

Both Conductor and all tmux sessions are gone.

**Detection:** `reconcileOnStartup()` finds tmux sessions are dead. Sessions not already marked `interrupted` or `dead` are marked `interrupted`.

**Recovery:** Same as Case 2 — user runs `/resume <name>`.

## Reconciliation on Startup

`reconcileOnStartup()` runs at every Conductor start. For each session in the database:

1. **Check Discord channel** — if the channel is gone, delete the session from DB (cleanup)
2. **Check tmux session** — if tmux is alive:
   - PID found → reattach (Case 1)
   - No PID → kill tmux, mark interrupted
3. **tmux dead** — mark interrupted if not already

Posts a reconciliation report to #orchestrator:
```
Reconciliation report:
  Healthy: session-a, session-b
  ↺ Reattached: session-c
  ⚠ Interrupted (use /resume <name> to recover): session-d
  Cleaned up: session-e
```

## Auto-Resume

If `AUTO_RESUME_ON_START=true`, Conductor automatically triggers `/sessions/spawn` for each interrupted session after the daemon starts. This is useful for unattended servers.

## Full Resume Flow

When `/resume <name>` is called:

1. **Read checkpoint** — load `.conductor-checkpoint.json` from the project directory
2. **Fetch Discord messages** — always fetch fresh from the channel (most up-to-date source)
3. **Merge messages** — combine checkpoint messages with Discord messages, deduplicating by timestamp proximity (within 2 seconds) and author
4. **Build resume prompt** — structured context document (see format below)
5. **Kill old tmux** — destroy any ghost tmux session
6. **Create new tmux session** — in the same project directory
7. **Write resume prompt** — save to `.conductor-resume-prompt.md` in the project directory
8. **Spawn Claude Code** — `claude --permission-mode acceptEdits`
9. **Wait for prompt** — auto-accept trust/permission dialogs (up to 30 seconds)
10. **Inject context** — send: `Read .conductor-resume-prompt.md and resume the session described in it. Acknowledge what you were working on.`
11. **Update state** — increment resume count, set status to `starting`
12. **Post notice** — `↺ Session <name> is resuming (resume #N)...`

## Resume Prompt Format

```
[CONDUCTOR RESUME — Session: my-session — Resume #2]

You are resuming a previous Claude Code session that was interrupted.
Project directory: /Users/matt/projects/my-session
Originally started: 2025-03-10T12:00:00.000Z
Interrupted: 2025-03-10T14:30:00.000Z (15 minutes ago)

--- Last known task ---
Working on implementing the search API endpoint and writing tests for it.

--- Git state at checkpoint ---
Branch: feature/search
Last commit: abc1234 Add search endpoint skeleton

--- Recent conversation (12 messages) ---
User: add search to the API
Claude: I've added a GET /search endpoint...
User: add pagination
Claude: Done, added limit and offset params...

--- End of resume context ---

Please acknowledge you have read the above context and are ready to continue.
State what you understand the current task to be and what your next action will be.
Do not repeat the resume context back verbatim.
```

## Resume Result

The resume endpoint returns:

| Field | Description |
|-------|-------------|
| `session` | Updated session object |
| `checkpointUsed` | Whether a checkpoint file was found and used |
| `messagesInjected` | Number of conversation messages included in the resume prompt |
| `resumePromptLength` | Character count of the resume prompt |

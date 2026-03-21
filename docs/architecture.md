# Architecture

## Components

Conductor consists of five main components:

```
┌──────────────────────────────────────────────────────────┐
│                    Discord Server                         │
│                                                          │
│  #orchestrator          #session-foo     #session-bar    │
│  (control plane)        (session ch)     (session ch)    │
└──────────┬──────────────────┬────────────────┬───────────┘
           │                  │                │
           ▼                  ▼                ▼
┌──────────────────────────────────────────────────────────┐
│                 Conductor Daemon (Node.js)                │
│                                                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────────┐  │
│  │ Discord  │ │ Express  │ │ Health   │ │ Checkpoint │  │
│  │ Bot      │ │ API      │ │ Monitor  │ │ Scheduler  │  │
│  │ (bot.ts) │ │(daemon.ts│ │(daemon.ts│ │(checkpoint │  │
│  │          │ │)         │ │)         │ │.ts)        │  │
│  └──────────┘ └──────────┘ └──────────┘ └────────────┘  │
│                       │                                  │
│              ┌────────┴────────┐                         │
│              │  Bridge Layer   │                         │
│              │  (bridge.ts)    │                         │
│              └────────┬────────┘                         │
│                       │                                  │
│              ┌────────┴────────┐                         │
│              │  tmux Wrapper   │                         │
│              │  (tmux.ts)      │                         │
│              └────────┬────────┘                         │
│                       │                                  │
│              ┌────────┴────────┐                         │
│              │  SQLite DB      │                         │
│              │  (sessions.ts)  │                         │
│              └─────────────────┘                         │
└──────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────┐
│                    tmux Sessions                          │
│                                                          │
│  conductor-foo            conductor-bar                  │
│  └─ claude --permission   └─ claude --permission         │
│     -mode acceptEdits        -mode acceptEdits           │
└──────────────────────────────────────────────────────────┘
```

### 1. Discord Bot (`src/bot.ts`)
Handles command parsing in #orchestrator and relays user messages from session channels to the bridge. Creates the "Conductor" category and #orchestrator channel on startup.

### 2. Express API (`src/daemon.ts`)
REST API on `localhost:7842` for session lifecycle operations (spawn, delete, list, resume). The Discord bot calls the API internally to handle commands.

### 3. Terminal Bridge (`src/bridge.ts`)
Polls tmux pane output every 1.5 seconds, detects Claude's responses via output markers, and posts them to Discord. Relays user messages from Discord to Claude via `tmux send-keys`.

### 4. SQLite Database (`src/sessions.ts`)
Persists session state to `data/conductor.db` using better-sqlite3 with WAL mode. Tracks session metadata, status, checkpoints, and resume counts.

### 5. tmux Sessions (`src/tmux.ts`)
Each Claude Code instance runs in a named tmux session (`conductor-<name>`). The bridge reads output via `tmux capture-pane` and sends input via `tmux send-keys`.

## Data Flows

### New Session
```
User → /new myapp → Discord Bot → POST /sessions/spawn → Daemon
  → Create Discord channel
  → Create DB record
  → Create tmux session
  → Send `claude --permission-mode acceptEdits`
  → Wait for Claude prompt (auto-accept trust/permission dialogs)
  → Start bridge
  → Post ready message
```

### Message Relay
```
User types in #myapp
  → Discord message event → sendToSession()
  → tmux send-keys to conductor-myapp
  → Bridge polls tmux capture-pane every 1.5s
  → Detects Claude's response (output markers + prompt)
  → Waits for stable pane (2 consecutive identical polls)
  → Posts response to Discord (split at 1900 chars)
```

### Graceful Shutdown
```
SIGTERM/SIGINT received
  → Post offline notice to #orchestrator
  → Flush all active checkpoints
  → Stop health monitor, checkpoint scheduler, all bridges
  → Kill all tmux sessions
  → Close DB, destroy Discord client
  → Exit
```

## File Map

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point — init, startup sequence, shutdown handler |
| `src/bot.ts` | Discord client, command handlers, message relay |
| `src/daemon.ts` | Express API, spawn/delete/list/resume, health monitor |
| `src/sessions.ts` | SQLite CRUD, migrations |
| `src/tmux.ts` | tmux command wrappers with retries |
| `src/bridge.ts` | Polling bridge: tmux ↔ Discord |
| `src/checkpoint.ts` | Checkpoint writing, scheduling, git/Discord capture |
| `src/resume.ts` | Session recovery, reconciliation, resume prompt builder |
| `src/pairing.ts` | Claude Code command builder |
| `src/logger.ts` | Structured timestamped logging |
| `src/types.ts` | TypeScript interfaces |

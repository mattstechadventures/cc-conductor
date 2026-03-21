# Conductor Documentation

Conductor is a self-hosted Discord-to-Claude Code terminal bridge. It turns a Discord server into a multi-session Claude Code orchestration hub — users post commands in a control channel, and Conductor spawns Claude Code sessions, creates matching Discord channels, and bridges two-way communication.

## Table of Contents

- [Architecture](architecture.md) — System overview, components, data flows
- [Discord Commands](commands.md) — `/new`, `/list`, `/kill`, `/resume`, `/mode`, `/help`
- [REST API](rest-api.md) — Express daemon endpoints
- [Session Lifecycle](session-lifecycle.md) — Spawning, active state, idle timeout, termination
- [Message Bridge](bridge.md) — Discord ↔ Claude Code relay via tmux polling
- [Checkpoints](checkpoints.md) — Periodic state snapshots for recovery
- [Resume & Recovery](resume-and-recovery.md) — Three failure modes and how Conductor handles each
- [Health Monitoring](health-monitoring.md) — Dead session detection, idle timeout enforcement
- [Configuration](configuration.md) — All environment variables and defaults
- [Deployment](deployment.md) — macOS launchd and Linux systemd setup
- [MCP Plugin](mcp-plugin.md) — Backup MCP-based Discord bridge
- [Typing Indicator](typing-indicator.md) — Discord typing indicator and `/mode` command

## Source Layout

```
src/
├── index.ts          # Entry point, startup/shutdown orchestration
├── bot.ts            # Discord client, command handlers
├── daemon.ts         # Express API, session lifecycle, health monitor
├── sessions.ts       # SQLite database layer
├── tmux.ts           # tmux command wrappers
├── bridge.ts         # Discord ↔ Claude polling bridge
├── checkpoint.ts     # Checkpoint writing and scheduling
├── resume.ts         # Session recovery and reconciliation
├── pairing.ts        # Claude Code command builder
├── logger.ts         # Structured logging
└── types.ts          # TypeScript interfaces
```

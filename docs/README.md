# Conductor Docs

- [Architecture](./architecture.md): daemon, session worker, and channel server roles
- [Commands](./commands.md): Discord control-plane commands and prefix settings
- Sessions can now gain extra allowed directories through `<prefix>add-dir`, without changing their base `projectDir`
- Startup failures in Discord are shortened to fit Discord message limits and point to worker diagnostics under `data/sessions/<sessionId>/`
- [Bridge](./bridge.md): structured Discord transport and PTY fallback
- [Session Lifecycle](./session-lifecycle.md): spawn, active, interruption, kill
- [Resume & Recovery](./resume-and-recovery.md): reconnect, Claude resume, checkpoint fallback
- [Configuration](./configuration.md): environment variables
- [Deployment](./deployment.md): service setup notes
- [Checkpoints](./checkpoints.md): what gets persisted for recovery
- [Health Monitoring](./health-monitoring.md): worker heartbeat and idle handling
- [REST API](./rest-api.md): daemon endpoints
- [MCP Plugin](./mcp-plugin.md): legacy experimental plugin path
- [Typing Indicator](./typing-indicator.md): `<prefix>mode` behavior

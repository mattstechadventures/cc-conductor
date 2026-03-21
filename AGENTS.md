# AGENTS.md

## Purpose
This repository is maintained as a cross-OS Claude Code session orchestrator. Any agent working here must preserve first-class support for Windows, macOS, and Linux.

## Non-Negotiables
- Do not introduce Unix-only assumptions into the core runtime.
- Do not make `tmux` a required dependency for the supported path.
- Do not make Bun a required dependency for the supported path.
- Do not rely on terminal pane scraping for primary message transport when a structured alternative exists.
- Do not hard-code platform paths, shells, or service locations in shared logic.

## Architecture Guardrails
- Core orchestration belongs in backend-neutral modules.
- Platform-specific behavior belongs behind explicit adapters or deploy scripts.
- Runtime code must use Node APIs for path and filesystem handling.
- Session state must describe generic handles and statuses, not backend-specific concepts unless isolated in adapter code.

## Change Checklist
- If you touch session lifecycle, review:
  - `docs/architecture.md`
  - `docs/session-lifecycle.md`
  - `docs/resume-and-recovery.md`
- If you touch configuration or env vars, update:
  - `.env.example`
  - `README.md`
  - `SETUP.md`
  - `docs/configuration.md`
- If you touch commands or bot behavior, update:
  - `docs/commands.md`
  - `docs/README.md`
- If you touch bridge/runtime behavior, update:
  - `docs/bridge.md`
  - `docs/mcp-plugin.md`
  - `docs/architecture.md`

## Testing Expectations
- Run `npm run typecheck` after code changes.
- For platform-sensitive changes, verify that logic branches explicitly for `win32`, `darwin`, and `linux` where required.
- Do not mark a feature complete if it only works on the current host OS unless the limitation is documented and intentional.

## Preferred Direction
- Move toward native PTY + structured transport.
- Reduce direct `tmux` coupling over time.
- Keep deployment scripts OS-specific, but keep the runtime itself cross-platform.

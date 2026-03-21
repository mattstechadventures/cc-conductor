# CLAUDE.md

## Project Context
Conductor is a Discord-based Claude Code session orchestrator. The long-term maintenance goal is cross-OS native functionality: Windows, macOS, and Linux must all be supported without Unix-only assumptions in the core runtime.

## Working Rules
- Prefer backend-neutral changes over platform-specific shortcuts.
- Use Node path and OS APIs, not shell-specific string logic.
- Treat `tmux` as legacy or optional unless the task explicitly says otherwise.
- Treat the MCP/plugin bridge as the direction for structured session transport.
- Keep Windows support equal in quality to macOS and Linux when changing runtime behavior.

## Before Editing
- Read the relevant docs in `docs/` for the subsystem you are touching.
- Check whether the change impacts commands, env vars, deployment, recovery, or bridge behavior.
- If it does, update the matching docs in the same change.

## Code Preferences
- Keep platform-specific code isolated.
- Prefer small adapter modules over scattered `process.platform` checks.
- Avoid hard-coded separators, temp paths, or shell names.
- Use explicit names that describe whether a concept is generic or backend-specific.

## Documentation Sync
- Update `README.md` and `SETUP.md` for user-visible behavior changes.
- Update architecture docs for lifecycle or transport changes.
- Do not leave Windows/macOS/Linux differences undocumented.

## Verification
- Run `npm run typecheck` after code changes.
- Call out any platform you could not verify.
- If a change only partially supports one OS, say so explicitly instead of implying parity.

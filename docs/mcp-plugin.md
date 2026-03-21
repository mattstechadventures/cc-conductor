# CC Conductor MCP Plugin

CC Conductor’s supported structured path now uses the generated Node server in `src/channel-server.ts`.

The `plugin/discord-autopair/` directory is kept only as a legacy experimental reference. It is not the supported production path.

## Visual Overview

```mermaid
%%{init: {'theme':'base','themeVariables': {'background':'#ffffff','primaryColor':'#E8F1FF','primaryTextColor':'#102A43','primaryBorderColor':'#2F6FED','lineColor':'#52606D','secondaryColor':'#E6FCF5','tertiaryColor':'#FFF4E6','fontFamily':'Segoe UI, Arial, sans-serif'}}}%%
flowchart LR
    Daemon[CC Conductor Daemon] --> Register[Register Local MCP Entry]
    Register --> Claude[Claude Code]
    Claude --> Channel[Generated Channel Server]
    Channel --> Daemon
    Legacy[Legacy plugin/discord-autopair] -. optional experiment .-> Claude

    classDef control fill:#E8F1FF,stroke:#2F6FED,color:#102A43,stroke-width:1.5px;
    classDef runtime fill:#E6FCF5,stroke:#0F766E,color:#134E4A,stroke-width:1.5px;
    classDef legacy fill:#F1F5F9,stroke:#94A3B8,color:#334155,stroke-width:1.5px,stroke-dasharray: 5 3;

    class Daemon,Register control;
    class Claude,Channel runtime;
    class Legacy legacy;
```

## Supported Path

- session-specific local-scope MCP entry in Claude's config for the active project
- session-scoped extra directory access applied through Claude `--add-dir` launch args, not through the channel server
- `node --import <repo-local tsx loader> src/channel-server.ts`
- Claude development channel selector: `--dangerously-load-development-channels server:<session-server-name>`
- daemon-owned Discord bot client
- localhost bearer-authenticated callbacks between the daemon and the channel server
- worker and terminal diagnostics under `data/sessions/<sessionId>/`

## Legacy Plugin Path

The plugin directory may still be useful for experimentation, but it is optional and not required for the main runtime.

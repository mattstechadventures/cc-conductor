# Deployment

## Visual Overview

```mermaid
%%{init: {'theme':'base','themeVariables': {'background':'#ffffff','primaryColor':'#E8F1FF','primaryTextColor':'#102A43','primaryBorderColor':'#2F6FED','lineColor':'#52606D','secondaryColor':'#E6FCF5','tertiaryColor':'#FFF4E6','fontFamily':'Segoe UI, Arial, sans-serif'}}}%%
flowchart LR
    Repo[Repo and .env] --> Runtime[Node Daemon]
    Runtime --> Mac[launchd plist]
    Runtime --> Linux[systemd service]
    Runtime --> Dev[Foreground dev run]
    Runtime --> Workers[Live Workers Continue Across Daemon Restarts]

    classDef control fill:#E8F1FF,stroke:#2F6FED,color:#102A43,stroke-width:1.5px;
    classDef runtime fill:#E6FCF5,stroke:#0F766E,color:#134E4A,stroke-width:1.5px;
    classDef storage fill:#FFF7E6,stroke:#D97706,color:#7C2D12,stroke-width:1.5px;

    class Repo control;
    class Runtime,Mac,Linux,Dev,Workers runtime;
```

## Runtime Requirements

- Node.js 20+
- Claude Code installed and authenticated with `claude.ai`

Optional only:

- `tmux` for the legacy backend
- Bun for legacy plugin experiments

## Important Behavior

The daemon can restart without killing session workers. That means service restarts are less disruptive than in the old tmux-owned architecture.

## Service Files

- macOS: [scripts/com.conductor.plist](/mnt/d/Repositories/cc-conductor/scripts/com.conductor.plist)
- Linux: [scripts/conductor.service](/mnt/d/Repositories/cc-conductor/scripts/conductor.service)

Keep the runtime itself cross-platform. OS-specific behavior belongs in the service layer, not the shared runtime.

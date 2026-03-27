# Checkpoints

Checkpoints are daemon-owned recovery snapshots written to `.conductor-checkpoint.json` in the project directory.

## Visual Overview

```mermaid
%%{init: {'theme':'base','themeVariables': {'background':'#ffffff','primaryColor':'#E8F1FF','primaryTextColor':'#102A43','primaryBorderColor':'#2F6FED','lineColor':'#52606D','secondaryColor':'#E6FCF5','tertiaryColor':'#FFF4E6','fontFamily':'Segoe UI, Arial, sans-serif'}}}%%
flowchart LR
    Session[Live Session State] --> Snapshot[Checkpoint Builder]
    Git[Git Branch and Commit] --> Snapshot
    Discord[Recent Discord History] --> Snapshot
    Summary[Task Summary] --> Snapshot
    Snapshot --> File[.conductor-checkpoint.json]
    File --> Resume[Fallback Resume Input]

    classDef control fill:#E8F1FF,stroke:#2F6FED,color:#102A43,stroke-width:1.5px;
    classDef runtime fill:#E6FCF5,stroke:#0F766E,color:#134E4A,stroke-width:1.5px;
    classDef storage fill:#FFF7E6,stroke:#D97706,color:#7C2D12,stroke-width:1.5px;

    class Session,Git,Discord,Summary runtime;
    class Snapshot control;
    class File,Resume storage;
```

Each checkpoint stores:

- session ID and name
- project directory
- timestamp
- current git branch
- latest git commit
- inferred task summary from recent Discord traffic
- recent Discord messages

Checkpoints no longer depend on terminal pane scraping.

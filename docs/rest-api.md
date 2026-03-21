# REST API

The daemon listens on `127.0.0.1:${CONDUCTOR_API_PORT}`.

## Visual Overview

```mermaid
%%{init: {'theme':'base','themeVariables': {'background':'#ffffff','primaryColor':'#E8F1FF','primaryTextColor':'#102A43','primaryBorderColor':'#2F6FED','lineColor':'#52606D','secondaryColor':'#E6FCF5','tertiaryColor':'#FFF4E6','fontFamily':'Segoe UI, Arial, sans-serif'}}}%%
flowchart LR
    Public[Public Client] --> PublicApi[Public Session Endpoints]
    Worker[Session Worker] --> Internal[Internal Worker Endpoints]
    Channel[Channel Server] --> ChannelApi[Internal Channel Endpoints]
    PublicApi --> Daemon[Daemon API]
    Internal --> Daemon
    ChannelApi --> Daemon
    Daemon --> SessionState[(Session State)]

    classDef edge fill:#F8FAFC,stroke:#64748B,color:#0F172A,stroke-width:1.5px;
    classDef control fill:#E8F1FF,stroke:#2F6FED,color:#102A43,stroke-width:1.5px;
    classDef runtime fill:#E6FCF5,stroke:#0F766E,color:#134E4A,stroke-width:1.5px;
    classDef storage fill:#FFF7E6,stroke:#D97706,color:#7C2D12,stroke-width:1.5px;

    class Public,Worker,Channel edge;
    class PublicApi,Internal,ChannelApi,Daemon control;
    class SessionState storage;
```

## Public Endpoints

- `POST /sessions/spawn`
- `DELETE /sessions/:id`
- `GET /sessions`
- `GET /sessions/:id`
- `POST /sessions/:id/ping`
- `POST /sessions/:id/resume`
- `POST /sessions/:id/add-dir`

## Internal Endpoints

These are localhost-only and require per-session bearer tokens:

- `POST /internal/sessions/:id/worker/register`
- `POST /internal/sessions/:id/worker/heartbeat`
- `POST /internal/sessions/:id/worker/notice`
- `POST /internal/sessions/:id/channel/register`
- `POST /internal/sessions/:id/channel/disconnect`
- `GET /internal/sessions/:id/channel/events`
- `POST /internal/sessions/:id/channel/reply`
- `POST /internal/sessions/:id/channel/react`

## Session Shape

Session payloads now describe generic runtime fields such as:

- `workerId`
- `terminalBackend`
- `terminalHandle`
- `transportKind`
- `transportState`
- `claudeSessionName`
- `claudeResumeRef`
- `workerStatus`

Legacy `tmuxSession` remains only for compatibility.

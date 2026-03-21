# Health Monitoring

The daemon checks active sessions every 60 seconds.

## Visual Overview

```mermaid
%%{init: {'theme':'base','themeVariables': {'background':'#ffffff','primaryColor':'#E8F1FF','primaryTextColor':'#102A43','primaryBorderColor':'#2F6FED','lineColor':'#52606D','secondaryColor':'#E6FCF5','tertiaryColor':'#FFF4E6','fontFamily':'Segoe UI, Arial, sans-serif'}}}%%
flowchart TD
    Tick[60s Health Tick] --> Heartbeat{Worker Heartbeat Fresh?}
    Heartbeat -->|No| Interrupted[Mark Interrupted]
    Heartbeat -->|Yes| Idle{Idle Timeout Exceeded?}
    Idle -->|Yes| Dead[Warn and Mark Dead]
    Idle -->|No| Transport{Channel Connected?}
    Transport -->|Yes| Healthy[Healthy Session]
    Transport -->|No| Degraded[Transport Degraded]

    classDef control fill:#E8F1FF,stroke:#2F6FED,color:#102A43,stroke-width:1.5px;
    classDef runtime fill:#E6FCF5,stroke:#0F766E,color:#134E4A,stroke-width:1.5px;
    classDef warning fill:#FEF2F2,stroke:#DC2626,color:#7F1D1D,stroke-width:1.5px;

    class Tick,Heartbeat,Idle,Transport control;
    class Healthy runtime;
    class Interrupted,Dead,Degraded warning;
```

## Worker Health

The primary liveness signal is the worker heartbeat. If a worker is missing or stale beyond the configured threshold, the session is marked interrupted.
Claude workers also self-interrupt if an unknown blocking modal persists for 30 seconds, so prompt/UI drift does not leave a session heartbeating forever while stuck.
Workers whose runtime build id is missing or mismatched are treated as stale immediately and are interrupted instead of being considered healthy.
If a stale worker does not accept authenticated shutdown anymore, CC Conductor falls back to terminating the local worker PID.

## Idle Timeout

If `SESSION_IDLE_TIMEOUT_MINS` is non-zero and the session exceeds that idle window:

- the daemon posts a warning to the Discord channel
- the worker is stopped
- the session is marked `dead`

## Transport Health

Channel connectivity is tracked separately from worker liveness. If the channel server disconnects, the session can temporarily fall back to PTY input while remaining alive.

# Message Bridge

The bridge (`src/bridge.ts`) is the core relay between Discord and Claude Code. It uses tmux pane polling to read Claude's output and `tmux send-keys` to send user input.

## How It Works

### Discord → Claude Code

When a user posts in a session channel:
1. `sendToSession()` is called with the message text
2. The message is sent to the tmux session via `tmux send-keys <msg> Enter`
3. Bridge state is updated: `waitingForResponse = true`, counters reset
4. The typing indicator starts (if enabled) — fires `channel.sendTyping()` immediately and every 8 seconds
5. `lastActiveAt` is updated in the database

### Claude Code → Discord

The bridge polls the tmux pane every 1.5 seconds:
1. `capturePaneOutput()` captures the last 500 lines of the tmux pane
2. A simple hash detects whether the pane changed since last poll
3. `extractResponse()` locates Claude's response in the pane output
4. When the pane is stable (2 consecutive identical polls) and Claude is at the `❯` prompt, the response is flushed to Discord

## Response Extraction

`extractResponse()` parses the raw terminal output:

1. **Find the sent message** — searches for the first 50 characters of the user's message (using `lastIndexOf` to handle repeated messages)
2. **Skip to output** — looks for Claude's output marker characters: `⏺`, `●`, `○`, `•` (different Claude Code versions use different bullets). Note: `⏵` is explicitly excluded — it appears in the status bar.
3. **Collect lines** — gathers everything until hitting a stop marker:
   - `❯` — Claude's prompt (done responding)
   - `📁` — status bar
   - `─` repeated 20+ times — separator line
4. **Clean output** — strips ANSI escape codes (`\x1b[...`) and OSC sequences (`\x1b]...\x07`)

## Stability Detection

The bridge doesn't flush output immediately. It waits for:
- Claude to be at the prompt (`❯` in last 12 lines, no "Running"/"Waiting"/"Simmering" status)
- The pane to be stable for `STABLE_THRESHOLD` (2) consecutive polls
- A response to have been detected

This prevents partial output from being sent to Discord.

## Message Splitting

Discord has a 2000-character message limit. The bridge splits responses at 1900 characters, preferring to break at newlines. Each chunk is sent as a separate Discord message.

## Bridge State

Each active session has a `BridgeState`:

| Field | Purpose |
|-------|---------|
| `lastSentMessage` | The last Discord message sent to Claude (used to locate response in pane) |
| `waitingForResponse` | Whether we're expecting Claude to respond |
| `stableTicks` | Consecutive polls with no pane change |
| `lastPaneHash` | Hash of last captured pane for change detection |
| `sawOutput` | Whether we've detected any output markers |
| `typingTimer` | Interval timer for Discord typing indicator (cleared on flush/stop) |

## Lifecycle

- `startBridge(session, client)` — creates a polling interval for the session
- `stopBridge(sessionId)` — clears the interval
- `stopAllBridges()` — stops all bridges (called during shutdown)

# Deployment

Conductor can run as a system service on macOS or Linux. Both configurations are provided in the `scripts/` directory.

## Prerequisites

- Node.js (with `tsx` installed globally or as a project dependency)
- tmux
- Claude Code CLI (`claude`) installed and authenticated
- Discord bot token configured in `.env`

## macOS (launchd)

**Config file:** `scripts/com.conductor.plist`

### Setup

1. Copy the project to `/opt/conductor` (or edit `WorkingDirectory` in the plist)
2. Install dependencies: `npm install`
3. Copy and configure environment: `cp .env.example .env` and fill in values
4. Copy the plist:
   ```bash
   cp scripts/com.conductor.plist ~/Library/LaunchAgents/
   ```
5. Load the service:
   ```bash
   launchctl load ~/Library/LaunchAgents/com.conductor.plist
   ```

### Behavior

- **RunAtLoad:** starts automatically on login
- **KeepAlive:** restarts if the process exits
- **Logs:** stdout → `/tmp/conductor.log`, stderr → `/tmp/conductor-error.log`

### Management

```bash
# Start
launchctl start com.conductor

# Stop
launchctl stop com.conductor

# Unload (disable)
launchctl unload ~/Library/LaunchAgents/com.conductor.plist

# View logs
tail -f /tmp/conductor.log
```

## Linux (systemd)

**Config file:** `scripts/conductor.service`

### Setup

1. Copy the project to `/opt/conductor` (or edit `WorkingDirectory` in the unit file)
2. Install dependencies: `npm install`
3. Copy and configure environment: `cp .env.example .env` and fill in values
4. Copy the unit file:
   ```bash
   sudo cp scripts/conductor.service /etc/systemd/system/
   ```
5. Enable and start:
   ```bash
   sudo systemctl enable conductor
   sudo systemctl start conductor
   ```

### Behavior

- **Restart:** always restarts on failure, 5-second delay
- **Environment:** loaded from `/opt/conductor/.env`
- **Logs:** systemd journal (`journalctl -u conductor`)
- **Security hardening:**
  - `NoNewPrivileges=true`
  - `ProtectSystem=strict`
  - `ReadWritePaths=/opt/conductor/data` (only the database directory is writable)

### Management

```bash
# Status
sudo systemctl status conductor

# Logs
journalctl -u conductor -f

# Restart
sudo systemctl restart conductor

# Stop
sudo systemctl stop conductor
```

## Running in Development

```bash
npm run dev
```

This uses `tsx` to run TypeScript directly without a build step.

## Building for Production

```bash
npm run build     # Compile to dist/
npm start         # Run with Node's tsx loader
```

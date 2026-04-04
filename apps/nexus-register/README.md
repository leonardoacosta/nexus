# nexus-register

Fast CLI binary that Claude Code hooks call on session start, stop, and heartbeat events. Each invocation writes a JSON event file to `~/.config/nexus/events/`, which the Rust file watcher detects and relays to the agent.

## Usage

```bash
nexus-register start      # Write session_start event
nexus-register stop       # Write session_end event
nexus-register heartbeat  # Write session_update event
```

## Environment Variables

| Variable | Description |
| --- | --- |
| `CLAUDE_SESSION_ID` | Session identifier. If unset, a stable ID is generated from PID + CWD. |

## Claude Code Hook Configuration

Add the following to your Claude Code `settings.json` (typically at `~/.claude/settings.json`):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/usr/local/bin/nexus-register start"
          }
        ]
      }
    ],
    "SessionStop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/usr/local/bin/nexus-register stop"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/usr/local/bin/nexus-register heartbeat"
          }
        ]
      }
    ]
  }
}
```

## Build

```bash
pnpm --filter @nexus/register build
```

This produces a single `nexus-register` binary via `bun build --compile`.

## Development

```bash
# Run directly
bun run src/index.ts start

# Run tests
bun test
```

## Event File Format

Events are written as JSON files to `~/.config/nexus/events/` with filenames like `{timestamp}-{session_id}.json`. The event shapes match the `WatcherEvent` type from `@nexus/core`:

```json
// session_start
{ "type": "session_start", "session_id": "abc-123", "project": "co", "path": "/home/user/dev/co" }

// session_end
{ "type": "session_end", "session_id": "abc-123" }

// session_update (heartbeat)
{ "type": "session_update", "session_id": "abc-123", "timestamp": "2026-04-03T12:00:00.000Z" }
```

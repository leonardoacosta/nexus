## Summary

Add automatic reconnection to the TUI client. When an agent connection drops (GoingAway, network error, or timeout), the TUI retries with exponential backoff and refreshes state on reconnect. Also surfaces DNS resolution errors clearly in the status bar.

## Motivation

Currently if the agent restarts, the TUI must be quit and relaunched. With graceful shutdown sending GoingAway, the TUI can detect planned shutdowns and reconnect automatically. DNS resolution failures (like Nova's "homelab" hostname issue) should surface as clear error messages, not silent retries.

depends on: add-graceful-shutdown

## Approach

1. Add `ReconnectManager` to TUI that wraps each agent connection
2. On connection loss: show "reconnecting..." in status bar, retry with exponential backoff (1s, 2s, 4s, 8s, max 30s)
3. On GoingAway: immediate reconnect attempt (planned shutdown, agent will be back soon)
4. On reconnect success: full session state refresh (GetSessions), show "reconnected" toast for 3s
5. On DNS resolution failure: show hostname + error in status bar, don't silently retry
6. Track per-agent connection state (Connected, Reconnecting(attempt), Disconnected(reason))

## Files Modified

- `crates/nexus-tui/src/client.rs` — ReconnectManager, exponential backoff, DNS error detection
- `crates/nexus-tui/src/app.rs` — per-agent connection state, reconnect UI state
- `crates/nexus-tui/src/screens/dashboard.rs` — reconnecting indicator per agent
- `crates/nexus-tui/src/main.rs` — wire reconnect manager into event loop

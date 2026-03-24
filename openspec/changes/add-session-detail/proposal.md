## Summary

Implement the full Session Detail screen (PRD T4). A dedicated view for inspecting a single session — metadata, status history timeline, agent info, and optional live stream output.

## Motivation

The dashboard shows session summary data but users need to drill into individual sessions to see full metadata, status transition history, and agent context. Currently the detail screen (`screens/detail.rs`) exists but is a stub.

## Approach

1. Design 3-panel layout: metadata (left), status timeline (center), live output (right, if streaming)
2. Populate metadata panel: session ID, project, branch, cwd, type (managed/ad-hoc), started_at, last_heartbeat, current status
3. Build status timeline showing state transitions with timestamps
4. Navigate with `d` from dashboard (on selected session), `q` to return
5. If session is streaming, right panel shows live output (reuse stream view renderer)

## Files Modified

- `crates/nexus-tui/src/screens/detail.rs` — full implementation replacing stub
- `crates/nexus-tui/src/app.rs` — add DetailView state, wire `d` key navigation
- `crates/nexus-tui/src/main.rs` — handle detail screen events
- `proto/nexus.proto` — add GetSessionDetail RPC if needed (or reuse GetSession with extended fields)

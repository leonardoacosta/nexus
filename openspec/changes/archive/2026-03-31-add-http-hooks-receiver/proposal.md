# Proposal: Add HTTP Hooks Receiver Endpoint

## Change ID
`add-http-hooks-receiver`

## Summary
Add a single `POST /hooks` endpoint to nexus-agent that receives Claude Code lifecycle events
(session start, session failure, session summary) via native HTTP hooks, dispatching them to
existing internal handlers.

## Context
- Extends: `crates/nexus-agent/src/http_handlers.rs` (new handler),
  `crates/nexus-agent/src/main.rs` (route registration),
  `crates/nexus-core/src/socket_event.rs` (may need new event variant for session_summary)
- Related: cc `upgrade-cc-hooks` spec (shipped 2026-03-31) — cc now emits HTTP hooks to
  `localhost:7401/hooks`

## Motivation
cc's settings.json now uses native HTTP hooks (`type: "http"`) for SessionStart and StopFailure
events, and telemetry.sh POSTs a session summary on Stop. All three target `POST /hooks` on
nexus-agent port 7401. Currently these return 404 because the endpoint doesn't exist. The socket
handler already processes session_start and session_stop events — the HTTP endpoint reuses the same
dispatch logic, providing a second transport for the same event types. The session_summary event is
new and gives nx per-session monitoring data (tool counts, failures, duration) that it currently
lacks.

## Requirements

### Req-1: Single Hooks Endpoint
A single `POST /hooks` endpoint SHALL accept CC hook payloads and session summary payloads,
dispatching to the appropriate internal handler based on the event type field in the JSON body.

### Req-2: Session Summary Processing
nexus-agent SHALL accept and store session summary data (tool counts, failure count, compaction
count, agent spawns, duration, model) for monitoring and aggregation via the `/hooks` endpoint.

## Scope
- **IN**: `POST /hooks` endpoint, event dispatch, session summary storage, integration with
  existing SessionRegistry and FailureBuffer
- **OUT**: TUI display of session summaries (separate spec), new gRPC events, changes to existing
  socket handler, auth on hooks endpoint (cc runs on same machine — localhost only)

## Impact
| Area | Change |
|------|--------|
| http_handlers.rs | New `hooks_handler` function (~50 lines) |
| main.rs | One `.route("/hooks", post(hooks_handler))` addition |
| socket_event.rs | New `SessionSummary` variant in SocketEvent enum |
| session registry | Store summary data alongside existing session tracking |

## Risks
| Risk | Mitigation |
|------|-----------|
| Duplicate events (HTTP hook + socket event for same session) | Deduplicate by session_id — if session already registered via socket, HTTP hook is idempotent |
| Malformed payloads from cc | Serde deserialization with `#[serde(default)]` on optional fields — reject with 400 on parse failure |
| Summary data grows unbounded | Summaries are per-session, cleaned up on session stop. In-memory only, not persisted. |

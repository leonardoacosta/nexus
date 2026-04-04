## Context
Nova subscribes to Nexus events to react to session lifecycle changes (errors, stale sessions,
completions). Currently it must poll or receive orchestrator-pushed triggers. A persistent
gRPC stream subscription eliminates polling and enables instant reaction.

The TUI already uses `StreamEvents` for its alert stream. This change makes the RPC
first-class for external consumers like Nova.

## Goals / Non-Goals
- **Goal**: Event type filtering, self-describing events (agent_name), initial snapshot
- **Goal**: Zero breaking changes to existing TUI usage
- **Non-Goal**: Push notifications (Nova handles its own Telegram relay)
- **Non-Goal**: Event persistence/replay (events are ephemeral)

## Decisions
- **Event type filtering via repeated enum**: Allows subscribing to multiple types.
  Empty list = all events (backward compatible). Filtering happens server-side to
  reduce bandwidth.
- **agent_name on event (not on connection)**: Events should be self-describing.
  If Nova connects to multiple agents, it needs to know which agent each event
  came from without tracking connection state.
- **Initial snapshot via flag**: Alternative was a separate RPC. Flag is simpler —
  one stream handles both bootstrap and live events. Snapshot events get a bool
  `is_snapshot` field so consumers can distinguish them from live events.

## Risks / Trade-offs
- Snapshot on reconnect could briefly duplicate events if a session starts between
  snapshot emission and broadcast subscription → Acceptable, consumers should be idempotent
- Adding fields to proto is additive, not breaking → Low risk

## Open Questions
- None — straightforward proto extension

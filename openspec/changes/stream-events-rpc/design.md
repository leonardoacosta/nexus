## Context

The agent needs to push real-time session events to connected TUI clients. The proto file already
defines `StreamEvents(EventFilter) returns (stream SessionEvent)` and the `SessionEvent` oneof
with `SessionStarted`, `HeartbeatReceived`, `StatusChanged`, `SessionStopped` variants. The
registry already tracks sessions via `RwLock<HashMap>`. This spec bridges the two by adding an
event broadcast layer.

## Goals / Non-Goals

- Goals:
  - Emit `SessionEvent` protobuf messages from the registry on every session state change
  - Deliver events to all connected TUI subscribers via server-streaming gRPC
  - Support `EventFilter` for filtering by session_id, project, or event type
  - Handle multiple simultaneous subscribers (fan-out)
- Non-Goals:
  - Event persistence or replay (events are fire-and-forget)
  - TUI-side subscription logic (spec 9)
  - Event batching or throttling (add later if needed)

## Decisions

- **Broadcast channel over mpsc**: `tokio::sync::broadcast` is chosen because multiple TUI clients
  can subscribe simultaneously. Each subscriber gets its own `Receiver` cloned from the channel.
  With mpsc, we would need a separate channel per subscriber and manual fan-out.
  - Alternative: `tokio::sync::watch` — rejected because watch only retains the latest value,
    losing intermediate events during rapid state changes.

- **Channel capacity**: 256 messages. If a slow subscriber falls behind, it receives a `Lagged`
  error and skips missed events. This prevents a slow client from blocking the registry. The TUI
  can handle `Lagged` by doing a full `GetSessions` refresh.
  - Alternative: unbounded — rejected to prevent memory growth from stalled subscribers.

- **EventBroadcaster as shared struct**: The `EventBroadcaster` holds the `broadcast::Sender` and
  is passed to both the registry (to emit events) and the gRPC service (to create receivers). Both
  hold `Arc<EventBroadcaster>` — no mutex needed since `broadcast::Sender::send` is lock-free.

- **Filter applied on receiver side**: The gRPC stream handler applies `EventFilter` after receiving
  from the broadcast channel, not at the sender side. This keeps the broadcast path simple (one
  channel for all events) and avoids per-filter channel proliferation.
  - Trade-off: Every subscriber receives all events even if filtered. Acceptable at Nexus scale
    (tens of sessions, not thousands).

- **Event emission points in registry**: Events are emitted at these points:
  - `upsert_sessions()`: compares new sessions with existing — emits `SessionStarted` for new IDs,
    `StatusChanged` for status transitions, `SessionStopped` for IDs that disappeared
  - `heartbeat()` (if it exists) or heartbeat path: emits `HeartbeatReceived`
  - The watcher calls `upsert_sessions()` on file change, which triggers diff-based events

## Risks / Trade-offs

- **Lagged subscribers**: A slow TUI client loses events. Mitigated by the TUI falling back to
  `GetSessions` on `Lagged` error. Documented in the spec for spec 9 to handle.
- **No replay on connect**: A new subscriber only sees events after subscribing, not historical
  state. The TUI must call `GetSessions` first, then subscribe to `StreamEvents` for updates.
  This is the standard pattern for gRPC server-streaming.

## Open Questions

- None — design is straightforward given the existing proto definitions and registry structure.

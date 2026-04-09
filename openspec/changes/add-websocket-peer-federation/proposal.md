# Proposal: WebSocket Peer Federation — Replace gRPC EventForwarder

## Change ID
`add-websocket-peer-federation`

## Summary
Replace the gRPC-based EventForwarder with WebSocket federation between Bun agents, enabling peer-to-peer session event streaming and notification routing without protobuf or tonic dependencies.

## Context
- Extends: `apps/agent/src/server.ts`, `apps/agent/src/notifications/`
- Related: `crates/nexus-agent/src/services/event_forwarder.rs`, `crates/nexus-agent/src/services/notification_engine.rs`

## Motivation
The EventForwarder in the Rust agent subscribes to peer agents' gRPC `StreamEvents` RPC to receive lifecycle events (session start/stop, heartbeat, status changes) from remote machines. These events feed the NotificationEngine which applies per-project rules and delivers TTS/iMessage/desktop notifications. With gRPC being removed (Phase 3), this peer-to-peer communication needs a new transport. WebSocket is the natural replacement — Bun has native WebSocket support, the protocol can use the same JSON event format as the Unix socket, and it's bidirectional for future command routing.

## Requirements

### Req-1: WebSocket peer endpoint
Add `GET /ws/federation` WebSocket endpoint to the Bun agent. Authenticated via `X-Nexus-Secret` header on upgrade. Sends all lifecycle events (session start/stop/heartbeat, status changes, spec transitions) as JSON frames to connected peers. Receives events from peers and routes to the notification engine.

### Req-2: Peer connector service
New service that reads `~/.config/nexus/agents.toml` for peer agent addresses, maintains persistent WebSocket connections to each peer (with reconnect backoff: 1s, 2s, 4s, 8s, max 30s). Filters self-agent from the list. Handles peer going offline gracefully (log warning, continue reconnecting).

### Req-3: Lifecycle event bus
Internal event bus (EventEmitter or BroadcastChannel) that replaces the Rust `EventBroadcaster`. Sources: socket server events, session manager state changes, spec watcher transitions, credential pool swaps. Consumers: WebSocket federation peers, SSE `/events` endpoint, notification engine.

### Req-4: Notification engine integration
Route federated lifecycle events through the existing Bun notification router (`apps/agent/src/notifications/router.ts`). Apply per-project notification rules from config. The Bun agent already has TTS, ElevenLabs, desktop, and iMessage channels — wire the federation events as a new event source.

## Scope
- **IN**: WebSocket federation endpoint, peer connector with reconnect, lifecycle event bus, notification engine wiring
- **OUT**: Modifying the TUI (retired in Phase 3), adding new notification channels, changing the agents.toml format

## Impact
| Area | Change |
|------|--------|
| `apps/agent/src/server.ts` | New `/ws/federation` WebSocket upgrade handler |
| `apps/agent/src/services/` | New `peer-connector.ts`, `lifecycle-bus.ts` |
| `apps/agent/src/notifications/router.ts` | Subscribe to lifecycle bus for federated events |
| `~/.config/nexus/agents.toml` | Read peer addresses (existing format, no changes) |

## Risks
| Risk | Mitigation |
|------|-----------|
| WebSocket connections drop under network instability | Exponential backoff reconnect (max 30s), event buffering during disconnect |
| Event ordering not guaranteed across peers | Include monotonic sequence numbers in event frames; consumers handle out-of-order |
| Flood of events from active peer overwhelms notification engine | Rate limit per-peer to 100 events/sec; batch notifications with 500ms debounce |

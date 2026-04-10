# Implementation Tasks

<!-- beads:epic:nx-ny4k -->

## API Batch

- [x] [1.1] [P-1] Create `apps/agent/src/services/lifecycle-bus.ts`: typed EventEmitter with events for SessionStarted, SessionStopped, SessionHeartbeat, StatusChanged, SpecTransition, CredentialSwap, NotificationFired — typed payloads, subscribe/unsubscribe, emit [owner:api-engineer]
- [x] [1.2] [P-1] Wire lifecycle bus into existing services: session-manager emits session events, spec-watcher emits transitions, credential pool emits swaps, socket server forwards relevant events to bus [owner:api-engineer]
- [x] [1.3] [P-1] Create `apps/agent/src/services/peer-connector.ts`: reads agents.toml, maintains WebSocket connections to each peer agent at `ws://{host}:{port}/ws/federation`, exponential backoff reconnect (1s→2s→4s→8s→max 30s), filters self-agent, logs connection state changes [owner:api-engineer]
- [x] [1.4] [P-2] Add `GET /ws/federation` WebSocket endpoint in server.ts: upgrade handler with X-Nexus-Secret auth, on connect subscribe to lifecycle bus and forward events as JSON frames, on receive parse peer events and inject into local lifecycle bus with `source: 'peer'` tag [owner:api-engineer]
- [x] [1.5] [P-2] Wire lifecycle bus into SSE /events endpoint: replace any direct event sourcing with bus subscription, ensuring both SSE and WebSocket federation receive the same events [owner:api-engineer]
- [x] [1.6] [P-2] Wire federated (peer-sourced) lifecycle events into notification router: apply per-project rules from notification config, route to TTS/desktop/iMessage channels via existing delivery infrastructure [owner:api-engineer]
- [x] [1.7] [P-3] Add event buffering: during peer disconnect, buffer up to 1000 events per peer, replay on reconnect with sequence-number-based dedup [owner:api-engineer]

## E2E Batch

- [x] [2.1] Write integration test: start two Bun agent instances on different ports, configure agents.toml to point at each other, trigger a session event on agent A, verify agent B receives it via federation WebSocket within 2s [owner:e2e-engineer]
- [x] [2.2] Write reconnect test: start peer connector, kill the target, verify backoff reconnect attempts at correct intervals, reconnect when target comes back, verify buffered events replayed [owner:e2e-engineer]
- [x] [2.3] Write notification integration test: inject a federated SessionStarted event from a peer, verify TTS notification fires via the notification router [owner:e2e-engineer]

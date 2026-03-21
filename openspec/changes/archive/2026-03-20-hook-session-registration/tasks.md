# Implementation Tasks

<!-- beads:epic:nexus-tsy -->

## DB Batch

- [x] [1.1] [P-1] Add RegisterSessionRequest, RegisterSessionResponse, UnregisterSessionRequest, UnregisterSessionResponse, HeartbeatRequest, HeartbeatResponse messages to proto/nexus.proto [owner:api-engineer] [beads:nexus-66k]
- [x] [1.2] [P-1] Add RegisterSession, UnregisterSession, Heartbeat RPCs to NexusAgent service in proto/nexus.proto [owner:api-engineer] [beads:nexus-tx9]

## API Batch

- [x] [2.1] [P-1] Add `register_adhoc` method to SessionRegistry that creates an ad-hoc session and emits SessionStarted event [owner:api-engineer] [beads:nexus-d5b]
- [x] [2.2] [P-1] Add `unregister` method to SessionRegistry that removes a session by ID and emits SessionStopped event (idempotent) [owner:api-engineer] [beads:nexus-39s]
- [x] [2.3] [P-1] Add `heartbeat` method to SessionRegistry that updates last_heartbeat and revives Stale→Active with StatusChanged event [owner:api-engineer] [beads:nexus-e3t]
- [x] [2.4] [P-1] Add `detect_stale` method to SessionRegistry: mark >5min idle as Stale, remove >15min idle [owner:api-engineer] [beads:nexus-od9]
- [x] [2.5] [P-1] Implement RegisterSession RPC in grpc.rs — call registry.register_adhoc [owner:api-engineer] [beads:nexus-m87]
- [x] [2.6] [P-1] Implement UnregisterSession RPC in grpc.rs — call registry.unregister [owner:api-engineer] [beads:nexus-2uu]
- [x] [2.7] [P-1] Implement Heartbeat RPC in grpc.rs — call registry.heartbeat [owner:api-engineer] [beads:nexus-ofl]
- [x] [2.8] [P-2] Delete watcher.rs entirely [owner:api-engineer] [beads:nexus-ei6]
- [x] [2.9] [P-2] Remove start_session_watcher call and watcher mod declaration from main.rs [owner:api-engineer] [beads:nexus-aun]
- [x] [2.10] [P-2] Remove notify crate from nexus-agent Cargo.toml [owner:api-engineer] [beads:nexus-6rk]
- [x] [2.11] [P-2] Add stale detection background task to main.rs (30s interval, calls registry.detect_stale) [owner:api-engineer] [beads:nexus-11u]

## UI Batch

- [x] [3.1] [P-1] Create crates/nexus-register/ with Cargo.toml (deps: tonic, nexus-core, clap) [owner:api-engineer] [beads:nexus-9sy]
- [x] [3.2] [P-1] Implement nexus-register main.rs with start/stop/heartbeat subcommands via clap [owner:api-engineer] [beads:nexus-7ia]
- [x] [3.3] [P-1] Implement gRPC client connection to localhost:7400 with 500ms timeout and silent error handling [owner:api-engineer] [beads:nexus-nxs]
- [x] [3.4] [P-2] Add nexus-register to workspace members in root Cargo.toml [owner:api-engineer] [beads:nexus-7ge]
- [x] [3.5] [P-2] Update deploy/hooks.d/post-merge/02-deploy to build and install nexus-register binary [owner:api-engineer] [beads:nexus-59d]
- [x] [3.6] [P-2] Add SessionStart hook to ~/.claude/settings.json calling nexus-register start [owner:api-engineer] [beads:nexus-lfr]
- [x] [3.7] [P-2] Add Stop hook to ~/.claude/settings.json calling nexus-register stop [owner:api-engineer] [beads:nexus-027]
- [x] [3.8] [P-2] Add PostToolUse hook to ~/.claude/settings.json calling nexus-register heartbeat [owner:api-engineer] [beads:nexus-5ox]

## E2E Batch

- [x] [4.1] Verify: build nexus-register, run nexus-agent, call nexus-register start/heartbeat/stop, confirm GetSessions reflects changes [owner:e2e-engineer] [beads:nexus-pbi]
- [x] [4.2] Verify: TUI displays ad-hoc sessions registered via nexus-register with correct [A] indicator and status transitions [owner:e2e-engineer] [beads:nexus-0a1]
- [x] [4.3] Verify: stale detection marks sessions Stale after 5min and removes after 15min [owner:e2e-engineer] [beads:nexus-2yo]
- [x] [4.4] Verify: nexus-register exits 0 silently when agent is not running [owner:e2e-engineer] [beads:nexus-4em]

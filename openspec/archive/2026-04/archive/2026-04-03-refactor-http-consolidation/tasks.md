# Tasks: Consolidate HTTP Servers

## Phase 1: Move Routes

- [ ] Add `/notifications/mode` GET/PUT handlers to `http_handlers.rs`
- [ ] Add `/notifications/history` GET handler
- [ ] Add `/notifications/meeting` GET handler (meeting queue status)
- [ ] Add `/notifications/rules` GET handler
- [ ] Add `/notifications/rules/:project` PUT handler
- [ ] Add `/speak` POST handler on :7402 (delegates to TtsService handle)
- [ ] Mount all new routes in `main.rs` HTTP router

## Phase 2: Remove ReceiverService Listener

- [ ] Remove `impl Service for ReceiverService` (the HTTP listener)
- [ ] Remove `spawn_service(receiver)` from `main.rs`
- [ ] TtsService becomes struct-only — constructed, not spawned as a service
- [ ] Playback queue spawned by NotificationEngine, not by TtsService::start()

## Phase 3: Port Cleanup

- [ ] Remove port 9999 from all config
- [ ] Remove `ReceiverService::with_bind_address()`
- [ ] Update remote relay URL from `:9999` to `:7402/speak` (or remove if relay eliminated by pipeline refactor)
- [ ] Remove port 9999 from firewall/documentation

## Phase 4: Socket Command Migration

- [ ] Remove `mode_query`, `mode_set`, `mode_cycle` socket commands
- [ ] Remove `notification_rules`, `notification_set` socket commands
- [ ] CC hooks use HTTP endpoints instead of socket commands for config
- [ ] Keep socket for fire-and-forget events only (session_start, notification, telemetry)

## Phase 5: Validate

- [ ] Verify single HTTP server on :7402 serves all routes
- [ ] Verify no process listens on :9999
- [ ] Verify TUI can query notification config via HTTP
- [ ] Update architecture docs (port table, diagram)

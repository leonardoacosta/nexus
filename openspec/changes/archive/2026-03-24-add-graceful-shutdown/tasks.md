## 1. Proto Changes
- [ ] 1.1 Add `GoingAway` message with `reason` (string) and `drain_timeout_ms` (uint32) fields
- [ ] 1.2 Add `StatusTransition` message with `from`, `to` (SessionStatus), `at` (Timestamp), `reason` (string)
- [ ] 1.3 Add GoingAway as a variant in SessionEvent payload oneof

## 2. Shutdown Coordinator
- [ ] 2.1 Register tokio SIGTERM handler in main.rs
- [ ] 2.2 Create `ShutdownCoordinator` with `CancellationToken` and active stream counter (AtomicUsize)
- [ ] 2.3 On SIGTERM: set cancellation token, log "shutdown initiated, draining N streams"
- [ ] 2.4 gRPC server stops accepting new connections (tonic graceful shutdown)

## 3. Stream Drain
- [ ] 3.1 StreamEvents handler increments/decrements active stream counter on connect/disconnect
- [ ] 3.2 On shutdown signal: send GoingAway message to all active streams with reason="agent shutting down" and drain_timeout_ms=5000
- [ ] 3.3 Wait up to 5s for all streams to close (check counter == 0)
- [ ] 3.4 After timeout or drain complete: exit with code 0

## 4. Validation
- [ ] 4.1 Manual test: connect TUI, send SIGTERM to agent, verify TUI receives GoingAway
- [ ] 4.2 Manual test: verify agent exits within 6s of SIGTERM (5s drain + 1s grace)
- [ ] 4.3 `cargo clippy && cargo test` passes

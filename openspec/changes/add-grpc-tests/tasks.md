## 1. Test Harness
- [ ] 1.1 Create `tests/common/mod.rs` with `start_test_server()` that binds gRPC to port 0 (random) and returns (addr, shutdown_handle)
- [ ] 1.2 Create `tests/grpc_integration.rs` with test module structure
- [ ] 1.3 Add `create_test_client(addr)` helper that creates a tonic NexusAgentClient

## 2. Session Lifecycle Tests
- [ ] 2.1 Test RegisterSession -> GetSessions (session appears in list)
- [ ] 2.2 Test RegisterSession -> GetSession by ID (correct fields returned)
- [ ] 2.3 Test UnregisterSession -> GetSessions (session removed)
- [ ] 2.4 Test Heartbeat updates last_heartbeat timestamp
- [ ] 2.5 Test GetSession with invalid ID returns NOT_FOUND

## 3. Streaming Tests
- [ ] 3.1 Test StreamEvents receives SessionStarted after RegisterSession
- [ ] 3.2 Test StreamEvents receives HeartbeatReceived after Heartbeat
- [ ] 3.3 Test StreamEvents receives SessionStopped after UnregisterSession
- [ ] 3.4 Test StreamEvents with EventFilter filters correctly

## 4. Command Tests
- [ ] 4.1 Test SendCommand returns stream of output events
- [ ] 4.2 Test StopSession returns appropriate result

## 5. Health and Discovery Tests
- [ ] 5.1 Test GetHealth returns valid machine metrics
- [ ] 5.2 Test ListAgents returns agent info
- [ ] 5.3 Test ListProjects returns project list

## 6. Validation
- [ ] 6.1 `cargo test --test grpc_integration` passes all tests
- [ ] 6.2 `cargo clippy` passes

## 1. Proto Changes
- [x] 1.1 Add `optional string target_agent` to `StartSessionRequest`
- [x] 1.2 Add `ListAgents` RPC returning agent name, host, port, connection status

## 2. Agent Implementation
- [x] 2.1 In `StartSession` handler: if `target_agent` is set and doesn't match this agent's name, return `NOT_FOUND`
- [x] 2.2 Implement `ListAgents` handler returning this agent's identity (each agent only knows itself; the client assembles the full list)

## 3. Validation
- [x] 3.1 Test: `StartSession` with matching `target_agent` succeeds
- [x] 3.2 Test: `StartSession` with non-matching `target_agent` returns NOT_FOUND
- [x] 3.3 Test: `StartSession` without `target_agent` works as before (backward compatible)
- [x] 3.4 `cargo clippy && cargo test` — 24 tests pass, 0 clippy errors

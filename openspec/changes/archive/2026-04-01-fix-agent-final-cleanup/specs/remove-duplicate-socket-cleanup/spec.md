## REMOVED Requirements

### Requirement: Redundant Socket Cleanup in run_socket_service
- The `cleanup_stale_socket()` call inside `run_socket_service` at `socket.rs:100` is removed; the canonical cleanup point is `main.rs:105`.

#### Scenario: Socket cleanup happens exactly once
- **GIVEN** the agent starts up
- **WHEN** `main.rs` calls `cleanup_stale_socket` before spawning the socket service
- **THEN** stale sockets are cleaned up
- **AND** `run_socket_service` does not call `cleanup_stale_socket` again

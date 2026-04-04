## REMOVED Requirements

### Requirement: Pre-gRPC HTTP API Types
**Reason**: `SessionListResponse`, `RegisterSessionRequest`, `HeartbeatRequest`, `StopSessionRequest`, and `SessionEvent` are completely unreferenced. The agent API migrated to gRPC; these types served the old HTTP API and are now dead code.
**Migration**: No migration needed. No consumers exist.

#### Scenario: Dead types no longer compile
- **WHEN** a developer attempts to use `SessionListResponse`, `RegisterSessionRequest`, `HeartbeatRequest`, `StopSessionRequest`, or `SessionEvent`
- **THEN** the code fails to compile because the types no longer exist

## ADDED Requirements

### Requirement: HealthResponse Preserved
The system SHALL continue to export `HealthResponse` from nexus-core for use by the agent HTTP health endpoint.

#### Scenario: Agent health endpoint uses HealthResponse
- **WHEN** the agent HTTP health handler constructs a response
- **THEN** it imports and uses `nexus_core::api::HealthResponse` successfully

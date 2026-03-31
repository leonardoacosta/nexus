# Proposal: Remove Dead Pre-gRPC API Types

## Change ID
`remove-dead-api-types`

## Summary
Delete 5 unused request/response types from `nexus-core/src/api.rs` that are vestigial from the pre-gRPC HTTP API era. Keep `HealthResponse` which is still actively used.

## Context
- Extends: `crates/nexus-core/src/api.rs`
- Related: gRPC migration completed previously; these types were never cleaned up

## Motivation
`SessionListResponse`, `RegisterSessionRequest`, `HeartbeatRequest`, `StopSessionRequest`, and `SessionEvent` are completely unreferenced across the entire workspace. Only `HealthResponse` is imported (by `crates/nexus-agent/src/http_handlers.rs`). Dead types add cognitive overhead and falsely suggest an active HTTP API contract.

## Requirements
### Req-1: Remove unused types
Delete `SessionListResponse`, `RegisterSessionRequest`, `HeartbeatRequest`, `StopSessionRequest`, and `SessionEvent` from api.rs.

### Req-2: Retain HealthResponse
Keep `HealthResponse` in api.rs (or relocate to health.rs) since it is actively imported by nexus-agent.

## Scope
- **IN**: Deleting 5 dead types from api.rs
- **OUT**: Restructuring the health module, changing HealthResponse fields

## Impact
| Area | Change |
|------|--------|
| nexus-core/api.rs | Remove ~40 lines of dead types |
| Unused imports in api.rs | Remove `Session` import if no longer needed |

## Risks
| Risk | Mitigation |
|------|-----------|
| Type used via dynamic dispatch or reflection | Rust has no runtime reflection; grep confirms zero references |

# Proposal: Centralize Proto-Domain Conversions in nexus-core

## Change ID
`refactor-centralize-proto-conversions`

## Summary
Move all proto<->domain conversion logic into nexus-core using idiomatic `From` trait impls, fixing field mapping bugs (hardcoded `SessionType::AdHoc`, dropped `tmux_target`).

## Context
- Extends: `crates/nexus-core/src/lib.rs` (proto module), `crates/nexus-core/src/session.rs`, `crates/nexus-core/src/health.rs`, `crates/nexus-core/src/command.rs`
- Related: `crates/nexus-agent/src/grpc/mod.rs:67-148` (session_to_proto, command_info_to_proto), `crates/nexus-tui/src/client.rs:555-630` (proto_to_session, proto_to_machine_health)

## Motivation
Proto-domain conversion functions are duplicated across agent and TUI crates with diverging behavior. Both hardcode `SessionType::AdHoc` instead of mapping the actual `session_type` field. The `tmux_target` field is silently dropped. Having conversions in two places means any proto schema change requires coordinated edits in both crates, increasing the risk of drift.

## Requirements
### Req-1: Canonical From trait impls in nexus-core
Implement `From<Session> for proto::Session`, `From<proto::Session> for Session`, `From<MachineHealth> for proto::MachineHealth`, `From<proto::MachineHealth> for MachineHealth`, and equivalents for `SessionStatus` and `CommandInfo` inside nexus-core.

### Req-2: Correct field mapping
Map `session_type` correctly (not hardcoded to AdHoc). Map `tmux_target` through the proto layer (add to proto schema if missing). All fields must round-trip without silent data loss.

### Req-3: Remove duplicated conversions
Delete `session_to_proto`, `session_status_to_proto`, `datetime_to_timestamp` from nexus-agent. Delete `proto_to_session`, `proto_to_machine_health`, `proto_timestamp_to_datetime` from nexus-tui. Replace call sites with `.into()` or `From::from()`.

## Scope
- **IN**: All proto<->domain conversions for Session, MachineHealth, SessionStatus, CommandInfo, timestamps
- **OUT**: gRPC service handler logic, proto schema redesign beyond adding missing fields

## Impact
| Area | Change |
|------|--------|
| nexus-core | New `proto_convert` module with `From` impls |
| nexus-agent/grpc | Remove ~80 lines of conversion code |
| nexus-tui/client | Remove ~80 lines of conversion code |
| Proto schema | Add `tmux_target` field if missing |

## Risks
| Risk | Mitigation |
|------|-----------|
| Proto schema change required for tmux_target | Optional string field — backward compatible |
| Numeric enum matching fragile | Use generated enum variants instead of raw i32 matching |

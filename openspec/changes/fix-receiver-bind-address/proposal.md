# Proposal: Bind ReceiverService to configured address

## Change ID
`fix-receiver-bind-address`

## Summary
The ReceiverService TTS HTTP server (port 9999) hardcodes `0.0.0.0` as its bind address, ignoring the `bind_address` setting in `agents.toml` that already controls the gRPC and HTTP servers. This closes the security gap left by the Wave 3 remediation.

## Context
- Extends: `crates/nexus-agent/src/services/receiver/service.rs` (bind logic at line 158), `crates/nexus-agent/src/claude_utils/notification_config.rs` (ServerConfig default), `crates/nexus-agent/src/main.rs` (ReceiverService construction)
- Related: `secure-agent-endpoints` (archived Wave 3 spec that fixed gRPC/HTTP but missed ReceiverService)

## Motivation
Wave 3 (`secure-agent-endpoints`) fixed the main gRPC (7400) and HTTP (7401) servers to respect `nexus_config.bind_address`, defaulting to `127.0.0.1`. However, the ReceiverService was missed -- it still hardcodes `SocketAddr::from(([0, 0, 0, 0], self.port))` at `service.rs:158` and the `ServerConfig` default in `notification_config.rs:36` is `"0.0.0.0"`. This means the TTS/notification endpoint is exposed on all network interfaces even when the user has configured localhost-only binding. This is a critical security finding from the post-remediation audit.

## Requirements

### Req-1: ReceiverService respects configured bind address
Pass the effective `bind_address` from `NexusConfig` into the `ReceiverService` constructor and use it when binding the TCP listener in `service.rs`, replacing the hardcoded `0.0.0.0`.

### Req-2: Safe default for notification ServerConfig
Update the `ServerConfig::default()` in `notification_config.rs` to use `"127.0.0.1"` instead of `"0.0.0.0"`, aligning with the security posture established in Wave 3.

### Req-3: All servers use consistent bind address
After this fix, gRPC (7400), HTTP (7401), and ReceiverService (9999) must all respect the same `bind_address` from `NexusConfig`.

## Scope
- **IN**: Threading `bind_address` into ReceiverService, updating `ServerConfig` default, updating `ReceiverService` constructors and `start()` method, updating log messages, updating tests
- **OUT**: Changing ReceiverService port configuration, modifying shared-secret auth, refactoring ReceiverService module structure

## Impact
| Area | Change |
|------|--------|
| `crates/nexus-agent/src/services/receiver/service.rs` | Add `bind_address` field, use it in `start()` TCP bind |
| `crates/nexus-agent/src/claude_utils/notification_config.rs` | Change `ServerConfig::default()` host from `"0.0.0.0"` to `"127.0.0.1"` |
| `crates/nexus-agent/src/main.rs` | Pass `nexus_config.bind_address` when constructing ReceiverService |
| `crates/nexus-agent/src/config.rs` | No change (agent-local `ServerConfig` has no host field) |

## Risks
| Risk | Mitigation |
|------|-----------|
| Breaking existing deployments that rely on `0.0.0.0` for ReceiverService | Same migration path as Wave 3: set `bind_address = "0.0.0.0"` in `agents.toml` to restore old behavior |
| notification_config.rs default change affects standalone usage | The agent always passes `bind_address` explicitly; standalone `NotificationsConfig` use gets the safer default |

## Summary

Investigate and fix the port drift issue where nexus-agent binds to port 8400 instead of the expected 7400 (gRPC) + 7401 (HTTP). Root cause is unknown — may be binary mismatch, systemd environment variable, or a code bug.

## Motivation

After agent restart, the health endpoint was found on port 8400 instead of 7400/7401, breaking all client connections (TUI + Nova). This makes the agent unreliable after restarts.

## Approach

1. Audit `crates/nexus-agent/src/main.rs` for port configuration — check for env var overrides, config file reads, and hardcoded values
2. Audit systemd service file for any port-related environment variables
3. Ensure port 7400 (gRPC) and 7401 (HTTP) are the only ports bound, with no fallback to other ports
4. Add startup log line confirming bound ports: `INFO nexus_agent: listening on gRPC=0.0.0.0:7400 HTTP=0.0.0.0:7401`
5. Add a startup self-test that verifies the ports are actually bound before accepting connections

## Files Modified

- `crates/nexus-agent/src/main.rs` — port binding audit + startup log
- `crates/nexus-agent/src/grpc.rs` — ensure gRPC server binds to configured port only
- `crates/nexus-agent/src/health.rs` — ensure HTTP health binds to configured port only

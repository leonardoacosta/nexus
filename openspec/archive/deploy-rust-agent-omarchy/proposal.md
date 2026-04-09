# Proposal: Deploy Rust nexus-agent to omarchy

## Change ID
`deploy-rust-agent-omarchy`

## Summary
Replace the Bun/JS nexus-agent binary on the omarchy (Arch Linux) machine with the Rust build from `target/release/nexus-agent`, restart the systemd service, and verify the new HTTP API on port 7402 alongside the existing gRPC on port 7400.

## Context
- Extends: `crates/nexus-agent`, `deploy/install.sh`, `~/.config/systemd/user/nexus-agent.service`
- Related: `credential-pool` spec, `credential-http-endpoint` spec, `credential-analytics` spec

## Motivation
The Rust nexus-agent (`crates/nexus-agent`) has been built and sits at `target/release/nexus-agent` (24MB, built Apr 4) but was never deployed to the omarchy machine. The installed binary at `~/.local/bin/nexus-agent` is still the old Bun/JS version that only serves gRPC on port 7400. The Rust agent adds an HTTP API on port 7402 with credential pool management, usage polling, atomic credential swap, and analytics. The systemd unit already sets `RUST_LOG=info` and expects a Rust binary — the Bun binary happens to run but does not provide the HTTP endpoints. Deploying the Rust binary unlocks the full credential management and analytics surface.

## Requirements

### Req-1: Replace installed binary
Stop the running service, back up the current Bun binary at `~/.local/bin/nexus-agent` to `~/.local/bin/nexus-agent.bun.bak`, and copy the Rust build from `~/dev/nx/target/release/nexus-agent` to `~/.local/bin/nexus-agent`.

### Req-2: Restart systemd service
Start the `nexus-agent.service` systemd user unit and confirm it reaches `active (running)` state without restart loops.

### Req-3: HTTP API health verification
`curl http://localhost:7402/health` must return HTTP 200, confirming the Rust HTTP server is listening.

### Req-4: Credential pool verification
`curl http://localhost:7402/credentials` must return a JSON list of accounts discovered from `~/.config/nexus/credentials/`. The pool should find all 17 credential accounts in that directory.

### Req-5: gRPC backward compatibility
The gRPC API on port 7400 must still accept connections after the binary swap — existing TUI and dashboard clients must not break.

## Scope
- **IN**: Binary swap, service restart, HTTP + gRPC verification, credential pool discovery check, backup of old binary
- **OUT**: Rust code changes, credential configuration changes, systemd unit file modifications, Traefik routing updates, TUI or dashboard changes, build from source (binary already built)

## Impact
| Area | Change |
|------|--------|
| `~/.local/bin/nexus-agent` | Bun/JS binary replaced with Rust binary |
| `nexus-agent.service` | Service restarted — now serves HTTP on 7402 in addition to gRPC on 7400 |
| Credential pool | 17 accounts discovered and managed via HTTP API |

## Risks
| Risk | Mitigation |
|------|-----------|
| Rust binary crashes on startup due to missing env vars or config | Systemd unit already has `RUST_LOG=info`; check `journalctl --user -u nexus-agent` immediately after start |
| gRPC clients break if Rust agent changes wire format | Rust agent uses same protobuf definitions; verify with existing TUI connection |
| Backup binary lost if cleanup happens prematurely | Only delete `nexus-agent.bun.bak` after multi-day stability confirmation |
| Credential directory permissions prevent pool discovery | Rust agent reads `~/.config/nexus/credentials/` — same path the Bun agent used; permissions already correct |

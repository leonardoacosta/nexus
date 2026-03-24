# Production Hardening — Phase Context

> Bootstrapped: 2026-03-23
> Previous phase: MVP (docs/plan/archive/2026-03-23-mvp/)

## Previous Phase Summary

Nexus MVP delivered in 5 days (2026-03-19 → 2026-03-23): 25 specs, ~9,000 LOC Rust, 32 tests,
4 crates. All PRD Must-have requirements complete. Full peer-to-peer session visibility and
command brokering across Tailscale network. Nova integration (5 unplanned specs) added as
external consumer.

## Carry-Forward: Deferred Tasks

None — MVP had zero deferred tasks.

## Carry-Forward: PRD Items Not Yet Started

From PRD § 8.1 milestones and requirement tables:

| ID | Item | PRD Priority |
|----|------|-------------|
| T4 | Session Detail screen (full version) | Should (M3) |
| T7 | Command palette — fuzzy search across sessions/projects/actions | Should (M3) |
| T13 | Start session from TUI — invoke StartSession RPC, prompt for project/cwd | Should (M3) |
| I1-I5 | iMessage integration (list, status, attach, stop) | Should (M3) |
| A11 | Hook migration stabilization (Option B already shipped, need 2-week soak) | Future |

## Current Codebase State

```
Cargo Workspace (Rust 2024, tokio async)
├── crates/nexus-core/     Shared types, protobuf codegen, session model
├── crates/nexus-agent/    Per-machine daemon (tonic gRPC + axum HTTP)
├── crates/nexus-tui/      Terminal UI client (ratatui + tonic)
└── crates/nexus-register/ CC hook helper binary (start/stop/heartbeat)

LOC:    ~9,000 Rust
Tests:  32
Deps:   tonic, ratatui, axum, sysinfo, notify, crossterm, reqwest
Ports:  7400 (gRPC), 7401 (HTTP /health)
Config: ~/.config/nexus/agents.toml
Deploy: systemd (Linux), launchd (Mac), pre-push git hook
```

## Runtime Observations

1. **Port drift**: After agent restart, only port 8400 was listening (not 7400/7401). Health
   endpoint response format also differed. Needs investigation — may be binary mismatch or
   config override.

2. **Memory usage**: Agent peaked at 1.3G memory, settled to ~450M. For a session tracker,
   this is high. Profile and optimize.

3. **Nova connectivity**: Nova config uses hostname `homelab` which doesn't resolve via DNS.
   Actual hostname is `omarchy`, Tailscale IP `100.94.11.104`. Config needs updating on Nova
   side, but Nexus should also surface better errors when clients connect with wrong hostnames.

4. **No graceful shutdown**: Agent doesn't drain gRPC streams on SIGTERM. Clients see
   connection reset instead of clean disconnect.

5. **No integration tests**: All 32 tests are unit tests. No gRPC client-server integration
   tests, no TUI rendering tests.

6. **No error recovery**: TUI doesn't auto-reconnect when agent restarts. Must quit and
   relaunch.

## Open Questions for This Phase

1. Should the agent support config hot-reload (agents.toml changes without restart)?
2. What's the memory budget? Is 450M acceptable or should we target <100M?
3. Should we add Prometheus metrics endpoint alongside /health?
4. Binary size target? Current release binary sizes unknown — measure and set target.
5. Should the TUI support multiple simultaneous stream views (split panes)?

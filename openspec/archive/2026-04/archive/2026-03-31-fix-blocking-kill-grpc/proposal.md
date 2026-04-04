# Proposal: fix(agent): replace blocking kill commands in gRPC handlers with async

## Change ID
`fix-blocking-kill-grpc`

## Summary
Replace three `std::process::Command::new("kill")` calls in gRPC session stop handler with non-blocking alternatives, preventing async executor stalls during session termination.

## Context
- Extends: `crates/nexus-agent/src/grpc/sessions.rs`
- Related: The same file already uses `tokio::process::Command` at line 103 for session bootstrap

## Motivation
The `stop_session` gRPC handler at lines 172, 204, and 218 shells out to the `kill` binary using `std::process::Command`, which blocks the tokio runtime thread for each invocation. The kill-0 probe at line 204 runs inside a polling loop (up to 40 iterations over 10 seconds), compounding the blocking impact. Since signal delivery is a simple syscall, the preferred fix is `nix::sys::signal::kill` which is instantaneous and non-blocking, avoiding both subprocess overhead and executor stalls.

## Requirements
### Req-1: Non-blocking signal delivery
Replace all three `std::process::Command::new("kill")` calls with `nix::sys::signal::kill()` for SIGTERM (line 172), kill-0 probe (line 204), and SIGKILL (line 218).

### Req-2: Process liveness probe without blocking
The kill-0 liveness check in the polling loop SHALL use a non-blocking mechanism (e.g. `nix::sys::signal::kill(pid, None)` or `nix::sys::signal::kill(pid, Signal::from(0))`).

## Scope
- **IN**: Three `std::process::Command::new("kill")` call sites in `grpc/sessions.rs`
- **OUT**: Other uses of `std::process::Command` elsewhere in the codebase

## Impact
| Area | Change |
|------|--------|
| `grpc/sessions.rs` | Three call sites converted from subprocess to direct syscall |
| `Cargo.toml` | Add `nix` crate with `signal` feature (or use `tokio::process::Command` if preferred) |
| Runtime | Eliminates 1-42 blocking subprocess spawns per session stop |

## Risks
| Risk | Mitigation |
|------|-----------|
| `nix` crate adds a new dependency | `nix` is lightweight and widely used; only enable `signal` feature to minimize footprint |
| Error handling differences between kill binary and nix syscall | Map `nix::errno::Errno::ESRCH` (no such process) to the same "process already gone" logic |
| Alternative: use `tokio::process::Command` instead of `nix` | Viable but heavier for a simple signal; `nix` is the idiomatic Rust approach |

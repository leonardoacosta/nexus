# Proposal: Retire Rust Crates — Single Bun Agent

## Change ID
`retire-rust-crates`

## Summary
Remove all Rust crates (`nexus-agent`, `nexus-core`, `nexus-tui`), proto files, Cargo workspace, and Rust-specific deploy infrastructure. The Bun agent becomes the sole nexus-agent process.

## Context
- Extends: `Cargo.toml`, `deploy/`, `.github/` (if CI exists)
- Related: Phases 1-4 must be complete before this phase executes

## Motivation
After Phases 1-4, all Rust agent capabilities have been ported to the Bun agent: Unix socket server, cron, spec watcher (Phase 1), HTTP routes (Phase 2), gRPC removed and TUI retired (Phase 3), peer federation via WebSocket (Phase 4). The Rust crates are now dead code. Removing them eliminates 50K lines of unmaintained Rust, the Cargo build toolchain requirement, protobuf compilation, and the dual-binary deploy complexity. The systemd service runs the Bun binary exclusively. The deploy hooks build only Bun.

## Requirements

### Req-1: Remove Rust source
Delete `crates/nexus-agent/`, `crates/nexus-core/`, `crates/archive/nexus-tui/` (archived in Phase 3), `proto/`, `build.rs` (if exists). Remove `Cargo.toml`, `Cargo.lock`, `.cargo/` config.

### Req-2: Update deploy hooks
Update `deploy/hooks.d/pre-push/01-deploy` to build only the Bun agent binary (remove `cargo build` steps). Update `deploy/hooks.d/post-merge/02-deploy` to remove Rust build steps. Update systemd service `ExecStart` to point at the Bun binary.

### Req-3: Update systemd service
Ensure `deploy/nexus-agent.service` `ExecStart` points to the Bun-compiled binary at `~/.local/bin/nexus-agent`. Remove `RUST_LOG` env var (replace with `LOG_LEVEL` or equivalent for Bun). Add `POSTGRES_URL` and `NEXUS_ENCRYPTION_KEY` env vars if not already present.

### Req-4: Clean up local machine
Remove Rust build artifacts: `target/` directory (~2GB), `~/.local/bin/nexus` (TUI binary, if not removed in Phase 3). Verify `~/.local/bin/nexus-agent` is the Bun binary. Verify `~/.local/bin/nexus-register` is still the Bun register binary.

### Req-5: Verify single-process operation
After retirement, only one nexus-agent process runs. It handles: HTTP on :7400, Unix socket at `/tmp/nexus-agent.sock`, WebSocket federation, all session/credential/health/project/spec/analytics routes. Health check: `curl http://localhost:7400/health` returns 200 with agent metadata.

## Scope
- **IN**: Rust source removal, Cargo workspace removal, deploy hook updates, systemd service update, local cleanup, verification
- **OUT**: Adding new Bun features, changing API contracts, modifying the Next.js dashboard

## Impact
| Area | Change |
|------|--------|
| `crates/` | Entire directory removed (~50K LOC) |
| `proto/` | Removed |
| `Cargo.toml`, `Cargo.lock` | Removed |
| `deploy/hooks.d/pre-push/01-deploy` | Rust build steps removed |
| `deploy/hooks.d/post-merge/02-deploy` | Rust build steps removed |
| `deploy/nexus-agent.service` | ExecStart updated to Bun binary |
| `target/` | ~2GB build artifacts removed |

## Risks
| Risk | Mitigation |
|------|-----------|
| Missed Rust-only capability not yet ported | Phase 1-4 completion gate; run full integration test suite before removal |
| CI pipeline references Cargo commands | Audit all CI/CD configs for cargo/rustc references |
| Other projects depend on nexus-core types | Check for external consumers; nexus-core was workspace-internal only |
| Git history bloat from large deletion | Single commit for clean `git bisect`; large files already in history regardless |

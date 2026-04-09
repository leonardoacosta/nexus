# Implementation Tasks

<!-- beads:epic:nx-bycr -->

## API Batch

- [ ] [1.1] [P-1] Delete `crates/nexus-agent/` directory [owner:api-engineer]
- [ ] [1.2] [P-1] Delete `crates/nexus-core/` directory [owner:api-engineer]
- [ ] [1.3] [P-1] Delete `crates/archive/nexus-tui/` directory (archived in Phase 3) [owner:api-engineer]
- [ ] [1.4] [P-1] Delete `proto/` directory [owner:api-engineer]
- [ ] [1.5] [P-1] Delete `Cargo.toml`, `Cargo.lock`, `.cargo/` from repo root [owner:api-engineer]
- [ ] [1.6] [P-2] Update `deploy/hooks.d/pre-push/01-deploy`: remove `cargo build --release -p nexus-agent` step, ensure only Bun agent build (`bun run build` in apps/agent) and nexus-register build remain, update install line to copy `apps/agent/nexus-agent` to `~/.local/bin/nexus-agent` [owner:api-engineer]
- [ ] [1.7] [P-2] Update `deploy/hooks.d/post-merge/02-deploy`: remove all `cargo build` steps, remove nexus-tui and nexus-register Rust builds, keep only Bun builds [owner:api-engineer]
- [ ] [1.8] [P-2] Update `deploy/nexus-agent.service`: change ExecStart to Bun binary path, replace `RUST_LOG=info` with `LOG_LEVEL=info`, add `POSTGRES_URL` and `NEXUS_ENCRYPTION_KEY` env vars [owner:api-engineer]
- [ ] [1.9] [P-3] Remove `packages/watcher/` directory (Rust watcher binary, no longer needed — Bun uses native file watching) [owner:api-engineer]
- [ ] [1.10] [P-3] Update `.gitignore` to remove `target/` entry, add any Bun-specific ignores [owner:api-engineer]

## E2E Batch

- [ ] [2.1] Clean up local machine: delete `target/` directory, remove `~/.local/bin/nexus` TUI binary, verify `~/.local/bin/nexus-agent` is the Bun binary via `file` command [owner:user]
- [ ] [2.2] Verify single-process operation: `systemctl --user restart nexus-agent`, confirm `curl http://localhost:7400/health` returns 200, confirm `/tmp/nexus-agent.sock` accepts connections, confirm no Rust processes in `pgrep -a nexus` [owner:e2e-engineer]
- [ ] [2.3] Verify deploy hook works end-to-end: make a trivial commit, push to main, confirm pre-push hook builds only Bun, confirm service restarts with Bun binary, confirm health check passes [owner:e2e-engineer]

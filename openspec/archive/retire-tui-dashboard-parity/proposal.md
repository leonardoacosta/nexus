# Proposal: Retire TUI — Dashboard Parity and gRPC Removal

## Change ID
`retire-tui-dashboard-parity`

## Summary
Verify the Next.js dashboard covers all TUI functionality, add any missing features, remove the gRPC server dependency, and archive `crates/nexus-tui`.

## Context
- Extends: `apps/nextjs/src/app/`, `crates/nexus-agent/src/grpc/`
- Related: `crates/nexus-tui/src/` (10,883 lines, 33 files), `proto/nexus.proto` (18 RPC methods)

## Motivation
The TUI (`crates/nexus-tui`) is the sole consumer of the gRPC API (18 RPC methods, 2 streaming). Maintaining gRPC forces keeping protobuf tooling, the `tonic` dependency chain, and 11K lines of Rust TUI code. The Next.js dashboard already provides session listing, session detail with live terminal, project overview, health monitoring, and credential views. By verifying dashboard parity and adding any missing features (spec velocity, failure trends, command execution), the TUI can be retired, eliminating the gRPC requirement entirely and unblocking the Bun consolidation.

## Requirements

### Req-1: Dashboard parity audit
Map every TUI screen to its dashboard equivalent. The TUI has: Dashboard (session list grouped by project), Detail (session inspect with terminal), Health (system metrics), Projects (project list with session counts), Credentials (account utilization), Specs (spec velocity chart), Failures (trend chart). Verify each has a working Next.js page.

### Req-2: Missing dashboard features
Add any TUI features not yet in the dashboard: (1) Session start from dashboard (spawn claude in project — POST /session/start integration), (2) Session stop from dashboard (kill session — existing API), (3) Spec velocity visualization, (4) Failure trends visualization, (5) Command execution (run project commands from dashboard).

### Req-3: gRPC server removal
Remove the gRPC server from the Rust agent (or mark as dead code for Phase 5 removal). Remove `proto/nexus.proto`, tonic dependencies from `Cargo.toml`, and all `grpc/` handler code. The Bun agent's HTTP + WebSocket API replaces all gRPC functionality.

### Req-4: TUI archival
Move `crates/nexus-tui` to a `crates/archive/nexus-tui` directory (preserving git history). Remove the `nexus` binary from deploy hooks and `~/.local/bin/`. Update `Cargo.toml` workspace members.

## Scope
- **IN**: Dashboard parity verification, missing feature additions, gRPC removal, TUI archival, deploy hook cleanup
- **OUT**: Rebuilding the TUI in a different technology, adding new dashboard features beyond TUI parity, modifying credential or session core logic

## Impact
| Area | Change |
|------|--------|
| `apps/nextjs/src/app/` | New pages for specs, failures, command execution |
| `crates/nexus-tui/` | Archived to `crates/archive/nexus-tui/` |
| `proto/nexus.proto` | Removed |
| `Cargo.toml` | Remove nexus-tui from workspace members |
| `deploy/hooks.d/pre-push/01-deploy` | Remove TUI binary build and install |

## Risks
| Risk | Mitigation |
|------|-----------|
| Dashboard missing a TUI feature we didn't identify | Comprehensive screen-by-screen audit before archiving |
| Users relying on TUI keyboard shortcuts for speed | Dashboard command palette (Cmd+K) provides equivalent quick access |
| Loss of offline/SSH access (TUI works over SSH, dashboard needs browser) | Accept this trade-off — SSH users can use the HTTP API directly via curl |

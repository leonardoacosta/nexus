# v2 — Phase Context

> Bootstrapped: 2026-04-03
> Previous phase: Polish & UX (docs/plan/archive/2026-04-03-polish-and-ux/)

## Previous Phase Summary

Polish & UX delivered in 10 days (2026-03-24 → 2026-04-03): 9 planned specs + 57 unplanned
specs. Codebase grew from 10K to 46K LOC Rust, tests from 61 to 662. All TUI rendering
hacks replaced with proper ratatui widgets. SQLite storage, credential management, notification
system, and extensive refactoring shipped alongside the original UX goals.

Three architecture refactor specs (central-db, http-consolidation, notification-pipeline)
were superseded by the decision to do a full TypeScript rewrite.

## Carry-Forward: Deferred Tasks

### Superseded Rust Refactors (71 tasks total — replaced by TS rewrite)
- `refactor-central-db` — 20 tasks (centralize DB access patterns)
- `refactor-http-consolidation` — 23 tasks (consolidate HTTP endpoints)
- `refactor-notification-pipeline` — 28 tasks (restructure notification flow)

These architectural improvements will be addressed natively in the TS rewrite rather than
retrofitting the Rust codebase.

## Carry-Forward: Open Ideas (1)

| Slug | ID | Description |
|------|-----|-------------|
| full-ts-rewrite | nx-bqm | Full TypeScript rewrite — Rust Cargo workspace → T3 Turbo monorepo with Next.js dashboard, tRPC API, Drizzle ORM |

## Carry-Forward: Open Beads

50 open beads issues from previous phases. Many reference Rust-specific work that will
be reframed in the TS rewrite context.

## Current Codebase State

```
Cargo Workspace (Rust 2024, tokio async)
├── crates/nexus-core/     Shared types, protobuf codegen, session model, SQLite store
├── crates/nexus-agent/    Per-machine daemon (tonic gRPC + axum HTTP)
├── crates/nexus-tui/      Terminal UI client (ratatui 0.30 + tonic)
└── crates/nexus-register/ CC hook helper binary (start/stop/heartbeat)

LOC:      46,462 Rust
Tests:    662 (10 suites)
Deps:     tonic, ratatui 0.30, axum, sysinfo, notify, crossterm, reqwest,
          pulldown-cmark, syntect, tui-textarea, rusqlite
Ports:    7400 (gRPC), 7401 (HTTP /health)
Config:   ~/.config/nexus/agents.toml (hot-reloaded)
Deploy:   systemd (Linux), launchd (Mac), pre-push git hook
```

## Runtime Observations

1. **Stability**: Agent daemon runs reliably with auto-reconnect, graceful shutdown,
   and hot-reloadable config.
2. **TUI maturity**: Production-grade ratatui widgets throughout — syntax highlighting,
   textarea input, gauges, sparklines, scrollbars, Block widgets.
3. **Notifications**: Meeting-aware queuing, project-aware routing, TTS with ElevenLabs,
   desktop notifications with custom icons.
4. **SQLite**: Analytics store operational for session/notification data.
5. **Credential pool**: Shared credential management across Claude Code sessions.

## v2 Direction: TypeScript Rewrite

The core decision driving this phase: migrate the entire Nexus Cargo workspace to a
T3 Turbo monorepo (Next.js + tRPC + Drizzle ORM).

**Gains:**
- Unified stack with 14 other T3 projects
- Next.js web dashboard (replaces TUI as primary interface)
- tRPC for type-safe API layer
- Drizzle ORM for database management
- Faster iteration on UI features

**Losses:**
- Binary deployment simplicity (Rust → Node.js runtime)
- Memory footprint advantages of Rust
- 46K lines of mature, tested Rust code

**Hybrid alternative:**
Keep Rust daemon for performance-critical paths (session management, health monitoring),
add Next.js frontend as the dashboard. Not yet decided — to be resolved in /plan:scope.

## Open Questions for This Phase

1. Full rewrite or hybrid (Rust daemon + TS frontend)?
2. Migration strategy: big bang or incremental?
3. Which Rust behaviors must be preserved exactly vs reimagined?
4. What happens to the 662 Rust tests?
5. How to handle the transition period (both systems running)?
6. TUI future: keep as secondary interface or deprecate?
7. How do the 50 open beads issues map to the new architecture?

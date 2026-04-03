# Scope Lock — Nexus v2

## Vision

A Bun-powered web dashboard that lets a small dev team see, stream, and interact with all their
Claude Code sessions across every machine — in real time, from any browser.

## Target Users

- **Lead developer** (Leo): 14 T3 projects, multiple machines, runs 5-10 Claude Code sessions daily
- **Team developers** (2-4): Engineers on the same projects who need visibility into active sessions
  and the ability to collaborate on complex multi-session workflows
- **Common trait**: All use Claude Code heavily, all have machines on the same Tailscale network

## Domain

**In scope:**
- Per-machine agent daemon (Bun, compiled to single binary)
- Central Next.js web dashboard (one instance, team accesses via browser)
- Real-time session streaming with full interactive control (WebSocket terminal relay)
- Session aggregation across all team machines
- Health monitoring (CPU, RAM, disk, Docker) per machine
- Project-level session grouping and status
- Meeting-aware notification queuing (carry forward from Rust)
- SQLite for analytics and session data (Bun native)
- Credential pool management across sessions

**Out of scope:**
- TUI client (killed — web dashboard replaces it entirely)
- gRPC (replaced by HTTP/WebSocket)
- Protobuf (replaced by JSON + TypeScript types)
- ratatui / terminal rendering
- Rust (except `notify`-based file watcher binary, kept for reliability)
- Mobile app
- SaaS / multi-tenant / public hosting
- AI model routing or prompt management
- IDE integrations (VS Code, JetBrains)

## Differentiator

**Only tool that aggregates AI coding sessions across machines with a web dashboard.**

No existing tool does this. CCManager (github.com/kbwo/ccmanager) manages sessions within
worktrees but has no web UI, no multi-machine aggregation, no collaboration. GoTTY/Muxplex
share terminals via web but have no AI session awareness. Gemini Code Assist has team
metrics but is single-instance SaaS.

Nexus v2 owns the "team AI session dashboard" category.

## Features to Steal

From **CCManager**: Session detection patterns, worktree-aware session handling, CLI ergonomics
for session management commands.

From **GoTTY**: WebSocket terminal relay architecture for browser-based terminal interaction.

From **Amp (Sourcegraph)**: Thread sharing and team context reuse patterns.

## v2 Must-Do

Ship a central web dashboard where team members can:
1. See all active Claude Code sessions across all machines
2. Stream any session's output in real time
3. Send input to any session (full interactive control)
4. View machine health and project status

If it can't do all four, it's not v2.

## v2 Won't-Do

- **No TUI**: The 46K-line ratatui TUI is retired. No maintenance, no slim CLI companion.
- **No tRPC**: Dashboard uses Server Actions. Agent-to-dashboard uses HTTP/WebSocket.
- **No gRPC/Protobuf**: Replaced by JSON APIs over HTTP and WebSocket streaming.
- **No Rust (except file watcher)**: The `notify`-based Rust file watcher stays as a separate
  binary. Bun agent communicates with it via subprocess/IPC. Everything else is Bun/TS.
- **No public access**: Tailscale-only network. No auth system beyond Tailscale ACLs.
- **No plugin system**: Direct integration only.
- **No multi-tenant**: Single team, single deployment.

## Business Model

Internal team tool. No revenue. No SaaS. No pricing.

Potential future: open-source if the tool proves valuable to others. But v2 is built
for one team's needs, not for distribution.

## Brand Direction

**Aesthetic**: Developer-tool dark mode. Think Linear meets btop. Dense information display,
minimal chrome, keyboard-first with mouse support. No gradients, no illustrations.

**Personality**: Fast, opinionated, no-nonsense. Shows you what matters, hides what doesn't.

## Scale Target

- **Year 1**: 2-5 developers, 3-5 machines, 10-20 concurrent sessions
- **Year 3**: Same team, possibly 8-10 machines, 30-50 concurrent sessions
- **Not building for**: 100+ users, enterprise, or multi-team

## Hard Constraints

| Constraint | Detail |
|------------|--------|
| Runtime | Bun (compiled single binary for agent daemon) |
| Dashboard | Next.js with Server Actions |
| Database | SQLite (Bun native, per-agent + central) |
| Network | Tailscale mesh — no public internet exposure |
| Auth | Tailscale ACLs — no custom auth system |
| File watching | Rust `notify` crate binary (kept from v1) — Bun agent communicates via IPC |
| Communication | HTTP + WebSocket (no gRPC, no protobuf) |
| Deploy | systemd (Linux), launchd (macOS) for agents; Vercel or self-hosted for dashboard |
| Existing data | No migration of Rust SQLite data — clean start |
| Session detection | Carry forward `nexus-register` hook pattern (CC pre-tool hooks) |

## Timeline

No external deadline. Internal tool built at own pace. Ship when ready.

**Phase preference**: Incremental — get the agent daemon + basic dashboard working first,
add collaboration features in parallel.

## Assumptions Corrected

- **"Hybrid is safer"** → Mostly full rewrite. One exception: Rust `notify`-based file watcher
  stays as a separate binary (battle-tested, no Bun/JS equivalent with same reliability).
  Everything else moves to Bun/TS.
- **"TUI has a future"** → TUI is dead. Web dashboard is the only interface.
- **"tRPC for consistency"** → Server Actions. The T3 ecosystem is moving this direction, and
  Nexus doesn't need the tRPC ceremony for a single dashboard.
- **"Node.js runtime"** → Bun. Single binary compilation, native SQLite, better WebSocket
  performance. Addresses the main trade-off concern (binary deployment).
- **"Read-only first, interact later"** → Full interaction in v2.0. It's the core differentiator.
  Without it, Nexus is just a log viewer.
- **"gRPC is the right transport"** → HTTP + WebSocket. Simpler, browser-native, no codegen.
  gRPC was chosen for Rust ergonomics, not for the problem domain.

## Open Questions Resolved

| Question | Resolution |
|----------|------------|
| Full rewrite or hybrid? | Near-full rewrite — Bun for everything except Rust file watcher |
| Migration strategy? | Clean start, no data migration |
| TUI future? | Killed |
| 662 Rust tests? | Not ported — new test suite for new architecture |
| Transition period? | No overlap — ship v2 when ready, turn off Rust |
| 50 open beads? | Triage during roadmap phase — many are Rust-specific and irrelevant |

## Prior Art Consumed

- **nx-bqm** (idea): Full TS rewrite — validated through this scope process, now committed
- **CCManager**: Session detection patterns to study
- **GoTTY**: WebSocket terminal relay architecture
- **Amp (Sourcegraph)**: Team thread sharing model

# Ambiguity Audit — Nexus PRD

> Generated: 2026-03-20
> PRD version: 1.2 (attach model resolved — all questions closed)

## Clarity Score: 10/10

**Rationale:** All 12 original findings resolved. All 5 open questions answered. Attach model
decided (nexus-managed sessions with two-tier UX). Scale targets concrete. Transport and wire
format specified. No weasel words, no TBDs, no vague quantities remain.

## Findings (All Resolved)

| # | Location | Pattern | Original | Resolution | Status |
|---|----------|---------|----------|------------|--------|
| 1 | §3 | Vague quantity | "20+ concurrent without TUI degradation" | "20 concurrent sessions render at 60fps with < 50ms input latency" | **Resolved** |
| 2 | §3 | Vague quantity | "2-5 machines, 20-50 concurrent sessions" | 2 MVP / 5 max. Primary: 4-5 sessions × 10 sub-agents. Secondary: 1 session × 5 sub-agents. | **Resolved** |
| 3 | §4.1 A1 | Undefined term | "sessions.json file watching" | inotify on Linux, FSEvents on Mac, polling fallback | **Resolved** |
| 4 | §4.2 T10 | Undefined term | "WebSocket upgrade (M3)" | Replaced with gRPC `StreamEvents` server-streaming RPC | **Resolved** |
| 5 | §4.6 | Weasel word | "TUI suspends cleanly" | `crossterm::terminal::disable_raw_mode()`, spawn SSH child, re-enable on exit | **Resolved** |
| 6 | §7.5 | Hedging | "after agent stabilizes" | "after 2 weeks of production use with zero session-tracking regressions" | **Resolved** |
| 7 | §10 Q1 | Unresolved decision | tmux session naming unknown | CC does not use tmux. Nexus-managed sessions use `nx-<short-id>`. Ad-hoc sessions are stream-only. | **Resolved** |
| 8 | §7.4 | Unresolved decision | SSE stream format undecided | Protobuf via gRPC `StreamEvents` with typed `SessionEvent` messages | **Resolved** |
| 9 | §7.7 | Unresolved decision | Project registry source undecided | Own registry, decoupled from daemon | **Resolved** |
| 10 | §7.6 | Unresolved decision | Heartbeat ownership undecided | File mtime (MVP, Option A) → HTTP heartbeat (target, Option B) | **Resolved** |
| 11 | §4.3 I5 | Missing edge case | No error handling for unreachable agents | Added: reply with offline status + last-seen timestamp | **Resolved** |
| 12 | §4.1 A5 | Missing edge case | "Graceful stop" unspecified | SIGTERM, wait 10s, SIGKILL. Plus alert notification system for stale/errored sessions. | **Resolved** |

## Summary

| Severity | Total | Resolved |
|----------|-------|----------|
| Critical | 1 | 1 |
| High | 3 | 3 |
| Medium | 6 | 6 |
| Low | 2 | 2 |
| **Total** | **12** | **12** |

## Architectural Decision Record: Attach Model

**Decision:** Nexus-managed sessions (two-tier)

**Context:** Claude Code does not run inside tmux. Sessions are bare processes on PTY devices
(e.g., children of Cursor's ptyHost). There is no tmux session to attach to for ad-hoc sessions.

**Options considered:**
1. Nexus-managed sessions (tmux wrap on spawn) — **Selected**
2. Stream-only (drop full attach from MVP)
3. Hook wrap (retroactive tmux reparenting) — Eliminated (architecturally broken)
4. PTY relay (/proc/pid/fd) — Eliminated (Linux-only, fragile)

**Decision:** Nexus-agent gains `StartSession` RPC that spawns CC inside tmux
(`tmux new-session -d -s nx-<id> -- claude`). Managed sessions get full terminal attach.
Ad-hoc sessions (started from Cursor/terminal) get stream-only attach.

**Validation:** OpenClaw (327k stars) chose stream-only — no tmux, no PTY. Their model works
because they control the full agent lifecycle. Nexus needs interactive control for managed
sessions, justifying the two-tier approach.

**Trade-offs accepted:**
- Two tiers of sessions (managed vs ad-hoc) with different capabilities
- Nexus scope expands from pure visibility to include session lifecycle (start/stop)
- tmux becomes a runtime dependency for managed sessions

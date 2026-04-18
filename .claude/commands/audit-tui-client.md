---
name: audit-tui-client
description: Code quality audit of the TUI Client domain — nexus-tui screens, navigation, streaming, keyboard handling.
---

# TUI Client Domain Audit

Audits the terminal UI: screens, client connections, event loop, keyboard handling, and stream rendering.

---

## Phase 0 — Pre-flight

Load domain memory:
```
Task({
  subagent_type: "Explore",
  model: "haiku",
  prompt: "Read /home/nyaptor/dev/nx/.claude/audit/memory/tui-client-memory.md and return full contents. Return NO_HISTORY if empty."
})
```

Check tests:
```bash
cd /home/nyaptor/dev/nx && cargo test -p nexus-tui 2>&1 | grep -E "test|FAILED|ok" | head -20
```

---

## Phase 1 — Source Code Review

```
Task({
  subagent_type: "Explore",
  model: "haiku",
  run_in_background: true,
  prompt: "Read these files in /home/nyaptor/dev/nx:
  - crates/nexus-tui/src/main.rs
  - crates/nexus-tui/src/app.rs
  - crates/nexus-tui/src/client.rs
  - crates/nexus-tui/src/screens.rs
  - crates/nexus-tui/src/keys.rs
  - crates/nexus-tui/src/stream.rs
  - crates/nexus-tui/src/stream_state.rs
  Focus on: event loop correctness, error states displayed, connection failure UX, keyboard handler completeness."
})
```

### App & Screens (`app.rs`, `screens.rs`)

| # | Area | What to check |
|---|------|---------------|
| 1 | Screen transitions | State machine — all transitions handled? |
| 2 | Error display | Agent connection failure shown to user? |
| 3 | Empty states | No sessions, no agents — meaningful message? |
| 4 | Refresh logic | Data staleness indicator? Auto-refresh interval? |
| 5 | `App::update_agents` | Panic on unexpected state? |

### Client (`client.rs`)

| # | Area | What to check |
|---|------|---------------|
| 1 | Connection failure | Graceful retry or terminal crash? |
| 2 | Agent unavailable | Partial data (some agents up, some down) handled? |
| 3 | Timeout handling | HTTP request timeouts configured? |
| 4 | `connect_all` | Sequential or parallel? Performance on many agents? |

### Stream (`stream.rs`, `stream_state.rs`)

| # | Area | What to check |
|---|------|---------------|
| 1 | Stream disconnect | Reconnection logic present? |
| 2 | `AlertEvent` handling | All alert types handled in UI? |
| 3 | Buffer size | Unbounded stream buffer? Back-pressure? |

### Key Handling (`keys.rs`)

| # | Area | What to check |
|---|------|---------------|
| 1 | Unknown key | Panic or graceful ignore? |
| 2 | Modal keys | ESC always dismisses? |
| 3 | Resize event | Terminal resize → layout recompute? |

---

## Phase 2 — OTel & Observability

| Check | Expected |
|-------|----------|
| OTel subscriber init | nexus-tui now has tracing-opentelemetry layer? |
| `OTEL_EXPORTER_OTLP_ENDPOINT` guard | OTel only init when env var set? |
| Sentry init | Present in main.rs before any setup? |
| `tracing::warn!` calls | Present at key failure points? |

---

## Evaluation Criteria

| Severity | Criteria |
|----------|----------|
| **P1** | TUI crash on agent disconnect, panic in event loop, unhandled key causes exit |
| **P2** | No error display, stale data without indicator, stream disconnect not recovered |
| **P3** | Missing keyboard shortcuts, suboptimal layout, no resize handling |
| **GCF** | Fuzzy search, multi-select, session filtering |

---

## Findings Output

```bash
echo '{"phase":"tui-client","domain":"rust","severity":"P2","description":"[description]","file_line":"[path:NN]","timestamp":"[ISO]","processed":false}' >> ~/.claude/scripts/state/nx-audit-findings.jsonl
```

---

## Output Format

```
## TUI Client Audit — [date]

### UX Completeness
| Screen/Feature | Status | Notes |
|----------------|--------|-------|

### Issues Found
| Sev | Area | Description | file:line |
|-----|------|-------------|-----------|

## Summary
- Total issues: N (P1: N, P2: N, P3: N, GCF: N)
**ready for /apply:all**
```

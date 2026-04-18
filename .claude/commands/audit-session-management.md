---
name: audit-session-management
description: Code quality and API contract audit of the Session Management domain — Rust gRPC handlers, Bun HTTP routes, Next.js session UI.
---

# Session Management Domain Audit

A single agent audits session lifecycle across all layers: Rust gRPC, Bun HTTP, and Next.js UI.

---

## Phase 0 — Pre-flight

Load domain memory (spawn Haiku Explore sub-agent):

```
Task({
  subagent_type: "Explore",
  model: "haiku",
  prompt: "Read /home/nyaptor/dev/nx/.claude/audit/memory/session-management-memory.md and return full contents. If file is empty or missing sections, return NO_HISTORY."
})
```

Check existing tests:
```bash
cd /home/nyaptor/dev/nx && cargo test -p nexus-agent 2>&1 | grep -E "test.*session|FAILED|ok" | head -20
find apps/agent/src -name "*.test.ts" | xargs grep -l "session" 2>/dev/null
```

---

## Phase 1 — Source Code Review

Spawn a background Explore sub-agent to read all relevant source files:

```
Task({
  subagent_type: "Explore",
  model: "haiku",
  run_in_background: true,
  prompt: "Read these files in /home/nyaptor/dev/nx and return: structure, error handling patterns, missing cases, suspicious logic.
  Files:
  - crates/nexus-agent/src/grpc/sessions.rs
  - crates/nexus-agent/src/services/session_pool.rs
  - apps/agent/src/routes/sessions.ts
  - apps/agent/src/session-manager.ts
  - apps/nextjs/src/app/session/[id]/page.tsx
  - apps/nextjs/src/app/actions/sessions.ts
  Focus on: error handling, race conditions, missing null checks, state transitions."
})
```

### Rust gRPC Handlers (`crates/nexus-agent/src/grpc/sessions.rs`)

| # | Handler | What to check |
|---|---------|---------------|
| 1 | `handle_start_session` | Spawn failure path, PID tracking, duplicate session guard |
| 2 | `handle_stop_session` | SIGTERM grace period, SIGKILL fallback, already-stopped case |
| 3 | `handle_get_session` | Session not found → correct gRPC status code |
| 4 | `handle_register_session` | Concurrent registration race, missing field validation |
| 5 | `handle_unregister_session` | Idempotency, missing session graceful handling |

### Bun Agent Routes (`apps/agent/src/routes/sessions.ts`)

| # | Route | What to check |
|---|-------|---------------|
| 1 | `GET /sessions` | Empty list, agent-unavailable fallback |
| 2 | `GET /sessions/:id` | 404 shape, session from wrong agent |
| 3 | Session manager | State machine correctness, heartbeat expiry |

### Next.js UI (`apps/nextjs/src/app/session/[id]/`)

| # | Route | What to check |
|---|-------|---------------|
| 1 | `/session/[id]` | Loading state, 404 state, stale session display |
| 2 | `/` (dashboard) | Session list empty state, sorting correctness |

---

## Phase 2 — API Contract Review

Verify type alignment between Rust `nexus-core` types and TypeScript `@nexus/core`:

```
Task({
  subagent_type: "Explore",
  model: "haiku",
  prompt: "Compare session types in:
  - /home/nyaptor/dev/nx/crates/nexus-core/src/session.rs
  - /home/nyaptor/dev/nx/packages/core/src/
  Look for: field name mismatches, missing fields, status enum coverage differences."
})
```

---

## Phase 3 — Observability & Error Handling

| Check | What to look for |
|-------|-----------------|
| Sentry breadcrumbs | session start/stop events have breadcrumbs? |
| OTel spans | `session.start` and `session.stop` spans present? |
| Tracing | `tracing::instrument` on gRPC handlers? |
| Error propagation | `anyhow::Error` converted to gRPC Status correctly? |
| TS error logging | Pino logger used in routes (not `console.log`)? |

---

## Evaluation Criteria

| Severity | Criteria |
|----------|----------|
| **P1** | Panic path, data loss, session state corruption, broken attach |
| **P2** | Missing error handling, unchecked unwrap, type mismatch, stale state |
| **P3** | Suboptimal logic, missing test coverage, minor inconsistency |
| **GCF** | Capability improvement opportunity |

---

## Findings Output

```bash
echo '{"phase":"session-management","domain":"rust","severity":"P2","description":"[description]","file_line":"[path:NN]","timestamp":"[ISO]","processed":false}' >> ~/.claude/scripts/state/nx-audit-findings.jsonl
```

---

## Output Format

```
## Session Management Audit — [date]

### Rust Layer
| Check | Status | Notes |
|-------|--------|-------|

### TypeScript Layer
| Check | Status | Notes |
|-------|--------|-------|

### API Contract
| Field | Rust | TypeScript | Match? |
|-------|------|-----------|--------|

### Issues Found
| Sev | Layer | Description | file:line |
|-----|-------|-------------|-----------|

### Game-Changing Opportunities
| Priority | Opportunity | Impact |
|----------|-------------|--------|

## Summary
- Total issues: N (P1: N, P2: N, P3: N, GCF: N)
- Biggest gap: [one sentence]
**ready for /apply:all**
```

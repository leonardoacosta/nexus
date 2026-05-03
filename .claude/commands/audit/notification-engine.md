---
name: audit:notification-engine
description: Reliability and correctness audit of the Notification Engine domain — notification_engine.rs, Bun notifications/, TTS delivery.
---

# Notification Engine Domain Audit

Audits notification delivery, TTS, meeting state, config hot-reload, and reliability.

---

## Phase 0 — Pre-flight

Load domain memory:
```
Task({
  subagent_type: "Explore",
  model: "haiku",
  prompt: "Read /home/nyaptor/dev/nx/.claude/audit/memory/notification-engine-memory.md and return full contents. Return NO_HISTORY if empty."
})
```

Check tests:
```bash
find /home/nyaptor/dev/nx -name "notifications*.test.ts" | xargs ls -la 2>/dev/null
cargo test -p nexus-agent 2>&1 | grep -E "notification|FAILED|ok" | head -20
```

---

## Phase 1 — Source Code Review

```
Task({
  subagent_type: "Explore",
  model: "haiku",
  run_in_background: true,
  prompt: "Read these files in /home/nyaptor/dev/nx:
  - crates/nexus-agent/src/notification_engine.rs
  - apps/agent/src/notifications/manager.ts
  - apps/agent/src/notifications/buffer.ts
  - apps/agent/src/notifications/router.ts
  - apps/agent/src/notifications/meeting-state.ts
  - apps/agent/src/routes/notifications.ts
  Focus on: delivery guarantees, buffer overflow, config reload atomicity, meeting state transitions."
})
```

### Rust Notification Engine (`notification_engine.rs`)

| # | Area | What to check |
|---|------|---------------|
| 1 | Config hot-reload | `spawn_config_watcher` — 100ms debounce — atomic swap? |
| 2 | TTS delivery | `speak_from_socket` — failure recovery? |
| 3 | Error notifications | `announce_errors` flag respected correctly? |
| 4 | Channel close | Engine stop breadcrumb emitted? |
| 5 | `Notification` struct | All fields validated before delivery? |

### TypeScript Notifications (`apps/agent/src/notifications/`)

| # | Area | What to check |
|---|------|---------------|
| 1 | Buffer | Overflow behavior — drop oldest or newest? |
| 2 | Manager | Multiple concurrent notifications — queued or parallel? |
| 3 | Meeting state | State machine — transitions complete? Invalid state handled? |
| 4 | Routes | `POST /notify` → input validation, 400 on bad payload? |

---

## Phase 2 — Reliability

| Check | What to verify |
|-------|----------------|
| TTS socket failure | Agent continues if `/tmp/nexus-agent.sock` unavailable? |
| Config parse failure | Malformed `notifications.toml` — fallback to last good config? |
| Delivery timeout | What if TTS delivery hangs? |
| Duplicate suppression | Same notification sent twice quickly — deduplicated? |

---

## Phase 3 — Observability

| Check | Expected |
|-------|----------|
| Breadcrumb: engine start | `notification.delivery` category, `Level::Info` |
| Breadcrumb: delivery success | Message content captured (non-PII check) |
| Breadcrumb: error notification | `Level::Error` on error-type notifications |
| Pino logging in TS | `createLogger("notifications")` used? |

---

## Evaluation Criteria

| Severity | Criteria |
|----------|----------|
| **P1** | Notification engine crash kills agent, delivery always fails |
| **P2** | Buffer overflow drops messages silently, config reload loses notifications |
| **P3** | Missing dedup, no timeout, suboptimal meeting state |
| **GCF** | Priority queue, delivery receipts, notification history |

---

## Findings Output

```bash
echo '{"phase":"notification-engine","domain":"rust","severity":"P2","description":"[description]","file_line":"[path:NN]","timestamp":"[ISO]","processed":false}' >> ~/.claude/scripts/state/nx-audit-findings.jsonl
```

---

## Output Format

```
## Notification Engine Audit — [date]

### Reliability Summary
| Check | Status | Notes |
|-------|--------|-------|

### Issues Found
| Sev | Layer | Description | file:line |
|-----|-------|-------------|-----------|

## Summary
- Total issues: N (P1: N, P2: N, P3: N, GCF: N)
**ready for /apply:all**
```

---
name: audit:notification-engine
description: Reliability and correctness audit of the Notification Engine domain — Bun notifications/, TTS delivery.
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
```

---

## Phase 1 — Source Code Review

```
Task({
  subagent_type: "Explore",
  model: "haiku",
  run_in_background: true,
  prompt: "Read these files in /home/nyaptor/dev/nx:
  - apps/agent/src/notifications/manager.ts
  - apps/agent/src/notifications/buffer.ts
  - apps/agent/src/notifications/router.ts
  - apps/agent/src/notifications/meeting-state.ts
  - apps/agent/src/notifications/rules-engine.ts
  - apps/agent/src/notifications/hook-rules.ts
  - apps/agent/src/notifications/hook-trigger.ts
  - apps/agent/src/notifications/held-queue.ts
  - apps/agent/src/notifications/presence-context.ts
  - apps/agent/src/routes/notifications.ts
  - apps/agent/src/routes/notification-settings.ts
  Focus on: delivery guarantees, meeting-hold durability, presence-rule correctness, meeting state transitions."
})
```

### TypeScript Notifications (`apps/agent/src/notifications/`)

| # | Area | What to check |
|---|------|---------------|
| 1 | Held-queue | `held-queue.ts` / `presence_holds` table — held notifications durable across agent restart? |
| 2 | Manager | Multiple concurrent notifications — queued or parallel? |
| 3 | Meeting state | State machine — transitions complete? Invalid state handled? |
| 4 | Routes | `POST /notifications/send` → input validation, 400 on bad payload? |

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

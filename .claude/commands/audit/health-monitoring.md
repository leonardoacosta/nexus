---
name: audit:health-monitoring
description: Correctness and completeness audit of the Health Monitoring domain — Rust health.rs, Bun health-collector, Next.js /health page.
---

# Health Monitoring Domain Audit

Audits system health collection, storage, history retrieval, and display.

---

## Phase 0 — Pre-flight

Load domain memory:
```
Task({
  subagent_type: "Explore",
  model: "haiku",
  prompt: "Read /home/nyaptor/dev/nx/.claude/audit/memory/health-monitoring-memory.md and return full contents. Return NO_HISTORY if empty."
})
```

Check tests:
```bash
cd /home/nyaptor/dev/nx && cargo test -p nexus-agent 2>&1 | grep -E "health|FAILED|ok" | head -20
cat /home/nyaptor/dev/nx/apps/agent/src/health-collector.test.ts 2>/dev/null | head -30
```

---

## Phase 1 — Source Code Review

```
Task({
  subagent_type: "Explore",
  model: "haiku",
  run_in_background: true,
  prompt: "Read these files in /home/nyaptor/dev/nx:
  - crates/nexus-agent/src/health.rs
  - crates/nexus-agent/src/services/server_monitor.rs (if exists)
  - apps/agent/src/health-collector.ts
  - apps/agent/src/health-scheduler.ts
  - apps/agent/src/routes/health-history.ts
  - apps/agent/src/db/health.ts
  - apps/nextjs/src/app/health/page.tsx
  - apps/nextjs/src/app/actions/health.ts (if exists)
  Focus on: data accuracy, retention policy, edge cases (disk full, sysinfo failure), DB schema."
})
```

### Rust Health Collector (`crates/nexus-agent/src/health.rs`)

| # | Area | What to check |
|---|------|---------------|
| 1 | `HealthCollector::spawn` | OTel `health.collect` span present? |
| 2 | Docker refresh | `DOCKER_REFRESH_TICKS` — Docker unavailable handled gracefully? |
| 3 | DB sample | `DB_SAMPLE_TICKS` — Write failure recovery? |
| 4 | `sysinfo` calls | System refresh before read? Stale data risk? |
| 5 | Memory calculation | Percentage vs absolute — consistent with UI? |

### TypeScript Health Collector (`apps/agent/src/health-collector.ts`)

| # | Area | What to check |
|---|------|---------------|
| 1 | Collection interval | Same as Rust (5s)? Configurable? |
| 2 | DB writes | Transaction used? Write failure logged? |
| 3 | Retention | Old samples pruned? Disk space awareness? |
| 4 | Error isolation | Collector crash doesn't kill agent? |

### Next.js Health Page (`apps/nextjs/src/app/health/`)

| # | Route | What to check |
|---|-------|---------------|
| 1 | `/health` | Loading state, empty state (no agents), stale data indicator |
| 2 | History chart | Time range handling, missing data points display |

---

## Phase 2 — Data Integrity

| Check | What to verify |
|-------|----------------|
| Schema alignment | Rust `HealthSampleRecord` matches DB schema in `apps/agent/src/db/health.ts` |
| Retention policy | How many samples kept? Config or hardcoded? |
| Null metrics | CPU 0%, memory 0% — real or sensor unavailable? |
| Multi-agent aggregation | Health from multiple agents displayed correctly in Next.js |

---

## Phase 3 — Observability

| Check | Expected |
|-------|----------|
| OTel `health.collect` span | Present in `health.rs` loop |
| Sentry breadcrumbs | Health collection failures captured? |
| Pino logging | TS health-collector uses `createLogger("health-collector")`? |
| Docker failure logged | Non-fatal Docker errors at `warn` level? |

---

## Evaluation Criteria

| Severity | Criteria |
|----------|----------|
| **P1** | Health collector crash kills agent, DB corruption, data loss |
| **P2** | Missing retention, inaccurate metrics, stale data displayed without indicator |
| **P3** | Minor inconsistency, hardcoded config, missing test coverage |
| **GCF** | Alerting on high CPU/memory, disk space warnings |

---

## Findings Output

```bash
echo '{"phase":"health-monitoring","domain":"rust","severity":"P2","description":"[description]","file_line":"[path:NN]","timestamp":"[ISO]","processed":false}' >> ~/.claude/scripts/state/nx-audit-findings.jsonl
```

---

## Output Format

```
## Health Monitoring Audit — [date]

### Data Accuracy
| Metric | Status | Notes |
|--------|--------|-------|

### Issues Found
| Sev | Layer | Description | file:line |
|-----|-------|-------------|-----------|

## Summary
- Total issues: N (P1: N, P2: N, P3: N, GCF: N)
**ready for /apply:all**
```

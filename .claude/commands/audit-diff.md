---
name: audit-diff
description: Targeted re-audit of files changed since the last audit wave — verifies fixes landed and no regressions introduced.
---

# Audit Diff — Nexus

Re-audits only files changed since last audit or since a specific commit. Faster than full `/audit-all`.

---

## Arguments

```
/audit-diff [--since=<git-ref>] [--domain=<domain>]
```

- `--since` — git ref (branch, commit, or tag). Default: last audit commit found in git log.
- `--domain` — restrict to a single domain.

---

## Phase 0 — Identify Changed Files

```bash
# Find changed files since last audit commit (or HEAD~20 as fallback)
LAST_AUDIT=$(git log --oneline | grep "audit" | head -1 | awk '{print $1}' || echo "HEAD~20")
git diff --name-only ${LAST_AUDIT}..HEAD | grep -E "\.(rs|ts|tsx)$"
```

Map changed files to domains:

| File pattern | Domain |
|-------------|--------|
| `grpc/sessions.rs`, `session*.ts` | session-management |
| `credential_pool.rs`, `credentials/` | credential-mgmt |
| `health.rs`, `health-collector.ts` | health-monitoring |
| `registry.rs`, `projects*.ts` | project-registry |
| `notification_engine.rs`, `notifications/` | notification-engine |
| `nexus-tui/` | tui-client |
| `terminal/` | terminal-attach |

---

## Phase 1 — Targeted Review

For each changed domain, spawn a focused review agent:

```
Task({
  subagent_type: "general-purpose",
  model: "haiku",
  prompt: "Review these changed files in /home/nyaptor/dev/nx: [file list]
  Check: 1) Do changes fix the previously reported issues? 2) Do changes introduce new issues?
  Context from memory: [domain memory contents]
  Output: diff review table with verdict per change."
})
```

---

## Phase 2 — Regression Check

```bash
cd /home/nyaptor/dev/nx && cargo test 2>&1 | grep "FAILED" | head -10
cd /home/nyaptor/dev/nx/apps/agent && bun test 2>&1 | grep "FAIL" | head -10
```

Any new test failures = P1 regression.

---

## Output Format

```
## Audit Diff — [date] (since [ref])

### Changed Files
| File | Domain | Lines +/- |
|------|--------|-----------|

### Fix Verification
| Previous Finding | Fix Present? | Notes |
|-----------------|--------------|-------|

### New Issues (if any)
| Sev | Domain | Description | file:line |
|-----|--------|-------------|-----------|

### Verdict
- Fixes landed: N/N
- New issues: N
- Regressions: N
```

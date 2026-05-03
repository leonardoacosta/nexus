---
name: audit:credential-mgmt
description: Security and correctness audit of the Credential Management domain — OAuth pool, rotation, Anthropic usage API.
---

# Credential Management Domain Audit

Audits the credential pool, rotation logic, usage API queries, and PII handling.

---

## Phase 0 — Pre-flight

Load domain memory:
```
Task({
  subagent_type: "Explore",
  model: "haiku",
  prompt: "Read /home/nyaptor/dev/nx/.claude/audit/memory/credential-mgmt-memory.md and return full contents. Return NO_HISTORY if empty."
})
```

Check credential-related tests:
```bash
cd /home/nyaptor/dev/nx && cargo test -p nexus-agent 2>&1 | grep -E "credential|pool|rotation|FAILED|ok" | head -20
find /home/nyaptor/dev/nx/apps/agent/src/credentials -name "*.test.ts" | xargs ls -la 2>/dev/null
```

---

## Phase 1 — Source Code Review

```
Task({
  subagent_type: "Explore",
  model: "haiku",
  run_in_background: true,
  prompt: "Read these files in /home/nyaptor/dev/nx and return analysis:
  - crates/nexus-agent/src/services/credential_pool.rs
  - crates/nexus-agent/src/services/credential_watcher.rs
  - crates/nexus-agent/src/usage_api.rs
  - apps/agent/src/credentials/pool.ts
  - apps/agent/src/credentials/store.ts
  - apps/agent/src/routes/credentials.ts
  Focus on: symlink atomicity, race conditions, token leakage, error recovery, debounce logic."
})
```

### Rust Credential Pool (`credential_pool.rs`)

| # | Area | What to check |
|---|------|---------------|
| 1 | `swap_credential` | Symlink atomicity — tmp + rename pattern used? |
| 2 | `poll_all_accounts` | Error isolation per account — one failure shouldn't stop others |
| 3 | Debounce logic | `is_debounce_active` — correct time math? |
| 4 | Token logging | Access tokens never logged (even at trace level)? |
| 5 | Usage API timeout | `query_usage` 5s timeout — what happens on timeout? |

### PII & Security

| # | Check | What to look for |
|---|-------|-----------------|
| 1 | Sentry `before_send` | Authorization headers redacted to `[REDACTED]`? |
| 2 | `send_default_pii: false` | Set in Sentry init? |
| 3 | Token in logs | grep for `access_token` in tracing macros |
| 4 | Credential file perms | Credential JSON files have restricted permissions? |

### TypeScript Credential Routes (`apps/agent/src/routes/credentials.ts`)

| # | Route | What to check |
|---|-------|---------------|
| 1 | `POST /credentials` | Input validation, duplicate handling |
| 2 | `POST /credentials/lease` | Concurrent lease safety |
| 3 | `POST /credentials/release` | Double-release handling |
| 4 | `POST /credentials/rate-limit` | Rate limit propagation correctness |

---

## Phase 2 — Security Audit

| Check | Status | Notes |
|-------|--------|-------|
| No tokens in git history | `git log --all -S "Bearer" --no-patch` | |
| No tokens in Sentry events | before_send redaction verified | |
| Credential files gitignored | `~/.config/nexus/credentials/` path is outside repo | |
| Usage API only calls Anthropic endpoint | Hardcoded URL, no env override | |
| OTel tags don't include token values | `ai.provider` tag is safe | |

---

## Phase 3 — Observability

| Check | Expected |
|-------|----------|
| Sentry breadcrumbs on swap | `credential.rotation` category present |
| Sentry AI tags | `ai.provider: anthropic` on usage queries |
| Breadcrumb on poll failure | `sentry::Level::Error` emitted |
| Timing tracked | `elapsed_ms` in AI breadcrumb data |

---

## Evaluation Criteria

| Severity | Criteria |
|----------|----------|
| **P1** | Token leak in logs/Sentry, symlink race condition, data loss |
| **P2** | Missing error handling, no timeout recovery, unsanitized input |
| **P3** | Suboptimal debounce, missing metrics, minor gaps |
| **GCF** | Multi-account rotation, smarter usage prediction |

---

## Findings Output

```bash
echo '{"phase":"credential-mgmt","domain":"security","severity":"P1","description":"[description]","file_line":"[path:NN]","timestamp":"[ISO]","processed":false}' >> ~/.claude/scripts/state/nx-audit-findings.jsonl
```

---

## Output Format

```
## Credential Management Audit — [date]

### Security Summary
| Check | Status | Notes |
|-------|--------|-------|

### Rust Layer Issues
| Sev | Description | file:line |
|-----|-------------|-----------|

### TypeScript Layer Issues
| Sev | Description | file:line |
|-----|-------------|-----------|

### Issues Found (All)
| Sev | Layer | Description | file:line |
|-----|-------|-------------|-----------|

## Summary
- Total issues: N (P1: N, P2: N, P3: N, GCF: N)
**ready for /apply:all**
```

---
name: audit-all
description: Full-platform code quality audit for nexus — all 7 domains in parallel. Rust crates, Bun agent, Next.js dashboard.
---

# Full Platform Audit — Nexus

Parallel code-quality agents audit all 7 domains simultaneously. No browser required — source code + API contract review.

**Project:** `/home/nyaptor/dev/nx`
**Domain count:** 7
**Agent port:** 7400

---

## Domains

| Domain | Agent Model | Key Source | Memory |
|--------|-------------|-----------|--------|
| session-management | single | grpc/sessions.rs, routes/sessions.ts | .claude/audit/memory/session-management-memory.md |
| credential-mgmt | single | services/credential_pool.rs, credentials/ | .claude/audit/memory/credential-mgmt-memory.md |
| health-monitoring | single | health.rs, health-collector.ts | .claude/audit/memory/health-monitoring-memory.md |
| project-registry | single | project_registry.rs, routes/projects.ts | .claude/audit/memory/project-registry-memory.md |
| notification-engine | single | notification_engine.rs, notifications/ | .claude/audit/memory/notification-engine-memory.md |
| tui-client | single | nexus-tui/src/ | .claude/audit/memory/tui-client-memory.md |
| terminal-attach | single | terminal/stream-manager.ts | .claude/audit/memory/terminal-attach-memory.md |

---

## Phase 0 — Pre-flight

### Build + Test Check (run in parallel)

```bash
# Rust build gate
cd /home/nyaptor/dev/nx && cargo build 2>&1 | grep -E "^error\[|Finished"

# Rust tests
cd /home/nyaptor/dev/nx && cargo test 2>&1 | grep -E "test result|FAILED" | head -20

# TypeScript agent tests
cd /home/nyaptor/dev/nx/apps/agent && bun test 2>&1 | grep -E "pass|fail|FAIL" | head -20
```

Any failing tests become automatic **P1 regressions** in the final report.

### Load All Domain Memory

Spawn 7 Haiku Explore sub-agents in parallel — one per domain memory file:

```
Task({ subagent_type: "Explore", model: "haiku",
  prompt: "Read /home/nyaptor/dev/nx/.claude/audit/memory/session-management-memory.md" })
Task({ subagent_type: "Explore", model: "haiku",
  prompt: "Read /home/nyaptor/dev/nx/.claude/audit/memory/credential-mgmt-memory.md" })
// ... one per domain
```

---

## Agent Architecture

Spawn all 7 agents in a **single message** with `run_in_background: true`:

| Agent | Domain | Type |
|-------|--------|------|
| A1 | session-management | general-purpose (Sonnet) |
| A2 | credential-mgmt | security-reviewer |
| A3 | health-monitoring | general-purpose (Haiku) |
| A4 | project-registry | general-purpose (Haiku) |
| A5 | notification-engine | general-purpose (Haiku) |
| A6 | tui-client | general-purpose (Haiku) |
| A7 | terminal-attach | security-reviewer |

Each agent prompt = read their `/audit-{domain}` command file and execute it.

---

## Phase 1 — Agent Dispatch

### Session Management (A1)
```
Task({ subagent_type: "general-purpose", model: "sonnet", run_in_background: true,
  prompt: "Execute /home/nyaptor/dev/nx/.claude/commands/audit-session-management.md — run all phases and output the full audit report." })
```

### Credential Management (A2)
```
Task({ subagent_type: "security-reviewer", run_in_background: true,
  prompt: "Execute /home/nyaptor/dev/nx/.claude/commands/audit-credential-mgmt.md — focus heavily on PII, token leakage, and symlink atomicity." })
```

### Health Monitoring (A3)
```
Task({ subagent_type: "general-purpose", model: "haiku", run_in_background: true,
  prompt: "Execute /home/nyaptor/dev/nx/.claude/commands/audit-health-monitoring.md — run all phases and output the full audit report." })
```

### Project Registry (A4)
```
Task({ subagent_type: "general-purpose", model: "haiku", run_in_background: true,
  prompt: "Execute /home/nyaptor/dev/nx/.claude/commands/audit-project-registry.md — run all phases and output the full audit report." })
```

### Notification Engine (A5)
```
Task({ subagent_type: "general-purpose", model: "haiku", run_in_background: true,
  prompt: "Execute /home/nyaptor/dev/nx/.claude/commands/audit-notification-engine.md — run all phases and output the full audit report." })
```

### TUI Client (A6)
```
Task({ subagent_type: "general-purpose", model: "haiku", run_in_background: true,
  prompt: "Execute /home/nyaptor/dev/nx/.claude/commands/audit-tui-client.md — run all phases and output the full audit report." })
```

### Terminal Attach (A7)
```
Task({ subagent_type: "security-reviewer", run_in_background: true,
  prompt: "Execute /home/nyaptor/dev/nx/.claude/commands/audit-terminal-attach.md — focus on PTY cleanup, auth checks, and resource leaks." })
```

---

## Findings Output

All agents append to the shared findings file:

```bash
~/.claude/scripts/state/nx-audit-findings.jsonl
```

Format per finding:
```json
{"phase":"<domain>","domain":"<layer>","severity":"P1|P2|P3|GCF","description":"...","file_line":"path:NN","timestamp":"ISO","processed":false}
```

---

## Issue Severity

| Severity | Criteria |
|----------|----------|
| **P1** | Panic/crash, data loss, security vulnerability, broken core flow |
| **P2** | Missing error handling, type mismatch, unchecked unwrap, stale state |
| **P3** | Minor inconsistency, missing test, suboptimal pattern |
| **GCF** | Game-changing feature or architecture opportunity |

---

## Output Collection

After all 7 agents complete, synthesize into a unified report:

```markdown
# Full Platform Audit — [date]

## Build Health
[Cargo + bun test results]

## Cross-Domain Issues
[Issues affecting multiple domains]

## Per-Domain Summary
| Domain | P1 | P2 | P3 | GCF | Biggest Gap |
|--------|----|----|----|----|-------------|

## All Issues (Priority Order)
| Sev | Domain | Layer | Description | file:line |
|-----|--------|-------|-------------|-----------|

## Game-Changing Opportunities
| Priority | Domain | Opportunity |
|----------|--------|-------------|

## Summary
- Total issues: N (P1: N, P2: N, P3: N, GCF: N)
- Regressions caught: N
- Highest risk domain: [one sentence]
**ready for /apply:all**
```

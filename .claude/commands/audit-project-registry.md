---
name: audit-project-registry
description: Code audit of the Project Registry domain — nexus-core project_registry.rs, agent registry.rs, Bun routes, Next.js /projects pages.
---

# Project Registry Domain Audit

Audits project discovery, registration, persistent tracking, and UI display.

---

## Phase 0 — Pre-flight

Load domain memory:
```
Task({
  subagent_type: "Explore",
  model: "haiku",
  prompt: "Read /home/nyaptor/dev/nx/.claude/audit/memory/project-registry-memory.md and return full contents. Return NO_HISTORY if empty."
})
```

Check tests:
```bash
cd /home/nyaptor/dev/nx && cargo test 2>&1 | grep -E "project|registry|FAILED|ok" | head -20
find /home/nyaptor/dev/nx/apps/agent/src -name "projects*.test.ts" | xargs ls -la 2>/dev/null
```

---

## Phase 1 — Source Code Review

```
Task({
  subagent_type: "Explore",
  model: "haiku",
  run_in_background: true,
  prompt: "Read these files in /home/nyaptor/dev/nx:
  - crates/nexus-core/src/project_registry.rs
  - crates/nexus-agent/src/registry.rs (if exists)
  - apps/agent/src/routes/projects.ts
  - apps/agent/src/routes/projects-discovered.ts
  - apps/agent/src/db/sessions.ts (project-related fields)
  - apps/nextjs/src/app/projects/page.tsx
  - apps/nextjs/src/app/projects/[name]/page.tsx
  - apps/nextjs/src/app/actions/projects.ts
  Focus on: discovery accuracy, dedup logic, stale project cleanup, path normalization."
})
```

### Core Project Registry (`crates/nexus-core/src/project_registry.rs`)

| # | Area | What to check |
|---|------|---------------|
| 1 | Project discovery | Directory scanning logic, symlink handling |
| 2 | Deduplication | Same project discovered by multiple mechanisms? |
| 3 | Path normalization | Absolute vs relative, `~` expansion |
| 4 | Serialization | `serde` derives — version compatibility? |

### Bun Agent Routes

| # | Route | What to check |
|---|-------|---------------|
| 1 | `GET /projects` | Sorting, filtering, pagination if any |
| 2 | `GET /projects/:name` | Project not found → 404 shape |
| 3 | `GET /projects/discovered` | Discovery vs confirmed projects distinction |
| 4 | Cross-agent projects | Same project on multiple agents — dedup in client? |

### Next.js Projects Pages

| # | Route | What to check |
|---|-------|---------------|
| 1 | `/projects` | Loading state, empty state, project count accuracy |
| 2 | `/projects/[name]` | Session count per project, stale projects |

---

## Phase 2 — Data Integrity

| Check | What to verify |
|-------|----------------|
| Project identity | What makes two project entries "the same"? name? path? |
| Stale cleanup | Projects with no sessions — displayed forever? |
| Multi-agent | Same project path on two agents — one entry or two? |
| Name collisions | Two projects with same name but different paths |

---

## Evaluation Criteria

| Severity | Criteria |
|----------|----------|
| **P1** | Project data loss, wrong session count, crash on discovery |
| **P2** | Stale projects accumulate, dedup failure, missing path normalization |
| **P3** | Minor display issues, sorting inconsistency |
| **GCF** | Project grouping across agents, git metadata integration |

---

## Findings Output

```bash
echo '{"phase":"project-registry","domain":"rust","severity":"P2","description":"[description]","file_line":"[path:NN]","timestamp":"[ISO]","processed":false}' >> ~/.claude/scripts/state/nx-audit-findings.jsonl
```

---

## Output Format

```
## Project Registry Audit — [date]

### Issues Found
| Sev | Layer | Description | file:line |
|-----|-------|-------------|-----------|

## Summary
- Total issues: N (P1: N, P2: N, P3: N, GCF: N)
**ready for /apply:all**
```

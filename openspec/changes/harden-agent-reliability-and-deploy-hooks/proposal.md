---
status: draft
after: close-credential-page-e2e-debt — same triage pass batch, no shared files, ordered for triage convenience only
---

# Proposal: Harden agent reliability and deploy-hook correctness (7 beads)

## Change ID
`harden-agent-reliability-and-deploy-hooks`

## Summary
Bundles 7 backend reliability and deploy-hygiene bugs found across recent incident
investigations into one openspec change spanning 5 capabilities: a repeated agent crash under
heavy concurrent load, a PTY-viewer output-garbling race, a stale duplicate of an already-fixed
disk-aggregation bug, two test-isolation bugs (cross-test leakage, PG cross-contamination), and
two deploy-hook correctness gaps (bun.lock drift, redundant Mac-side migration).

## Context
- Related: nx-k7xa (already fixed — the original `aggregateDiskPercent` bug nx-4l1zt is a stale duplicate of)
- touches: `apps/agent/src/server-health-handler.ts`, `apps/agent/src/health-scheduler.ts`, `apps/swift/nexus-mac/Sources/.../PtyViewer.swift`, `apps/agent/src/terminal/tmux-pty-source.ts`, `apps/agent/src/services/reaper-persistence.test.ts`, `deploy/hooks.d/post-merge/02-deploy`, `deploy/hooks.d/post-merge/03-migrate`

## Motivation
Each item is an independently-reproduced, already-investigated bug (see individual bead
descriptions for full repro detail) — this proposal exists to give them tracked implementation
batches rather than leaving them as unattached beads:

- **nx-t9wlb**: nexus-agent crashed 3x (SIGABRT/SIGILL) in ~2min under ~13 concurrent CC
  sessions, memory pinned at 99.9% of a 512MB cap — no kernel OOM-kill logged.
- **nx-f1l69**: Mac dashboard PTY viewer shows garbled output — the renderer (SwiftTerm) and
  byte-streaming (tmux pipe-pane) are both confirmed correct; the garble is an attach-handshake
  / geometry race (bytes arriving before the initial resize frame).
- **nx-4l1zt**: `server-health-handler.ts:202-215` re-implements the same multi-disk
  aggregation bug already fixed elsewhere (nx-k7xa) via `aggregateDiskPercent()` — a stale
  duplicate that never got the fix.
- **nx-gwnpb**: `reaper-persistence.test.ts` shares one schema/db handle across all cases via a
  single `beforeAll` with no per-test cleanup, causing order-dependent false pass/fail.
- **nx-rzaej**: Under `NEXUS_HEAVY_TESTS=1 NEXUS_PG_TESTS=1`, 17 PG-gated tests fail that pass
  standalone — `mock.module` leakage across files in a full-suite run.
- **nx-zpbqi**: The homelab post-merge deploy hook's `bun install --frozen-lockfile` fails
  because the committed `bun.lock` no longer matches what `bun install` resolves — non-fatal to
  git but `nexus-agent` doesn't get a fresh dependency sync.
- **nx-9k141**: The Mac's post-merge `db:migrate` step fails loudly (`POSTGRES_URL is required`)
  on every deploy — redundant since the homelab primary already migrates the shared DB; should
  skip entirely on a non-primary machine rather than fail.

## Requirements

### Requirement: nexus-agent SHALL remain stable under heavy concurrent session load
The agent process MUST NOT crash (SIGABRT/SIGILL) under sustained heavy concurrent multi-session
load. Memory usage approaching the systemd `MemoryMax` cap MUST be diagnosable (structured
logging of memory pressure) rather than terminating via an uncaught native-level abort.

### Requirement: PTY viewer attach handshake SHALL establish terminal geometry before feeding output bytes
The Mac dashboard's PTY viewer MUST NOT feed streamed PTY bytes to the VT emulator (SwiftTerm)
before the initial `resize(cols, rows)` geometry frame has been applied, eliminating the
attach-handshake race that produces garbled/jumbled output.

### Requirement: Disk aggregation logic SHALL NOT be duplicated across health-reporting call sites
Every call site that aggregates multi-disk percentage MUST call the shared
`aggregateDiskPercent()` helper rather than re-implementing the aggregation inline, so a fix to
the shared helper cannot leave a stale duplicate uncorrected.

### Requirement: Test files SHALL isolate database/schema state per test case
A test file sharing one database/schema handle across multiple test cases via `beforeAll` MUST
perform per-test cleanup (or per-test isolation) so an earlier test's inserted rows cannot
change a later test's pass/fail outcome depending on run order.

### Requirement: PG-gated tests SHALL NOT cross-contaminate under a full-suite heavy-test run
Tests gated by `NEXUS_PG_TESTS`/`NEXUS_HEAVY_TESTS` MUST produce the same pass/fail outcome
whether run standalone or as part of a full `bun test apps/agent` run — `mock.module` mocks
installed by one test file MUST NOT leak into another file's test execution.

### Requirement: The post-merge deploy hook SHALL recover from a bun.lock frozen-install mismatch
`deploy/hooks.d/post-merge/02-deploy` MUST detect a `bun install --frozen-lockfile` failure
caused by lockfile drift and either regenerate the lockfile safely or surface an actionable,
non-silent recovery path, rather than continuing with a stale `node_modules` for `nexus-agent`.

### Requirement: The post-merge DB migration hook SHALL skip entirely on a non-primary machine
`deploy/hooks.d/post-merge/03-migrate` MUST detect when the current machine is not the primary
DB-writing host and skip `db:migrate` entirely (not just warn on a missing `POSTGRES_URL`),
since the primary host already applies the shared migration.

## Scope
- **IN**: the 5 capability areas listed above, scoped exactly to each bead's described root
  cause (see Motivation)
- **OUT**: any broader refactor of the health-scheduler, PTY subsystem, or deploy pipeline
  beyond each bead's specific fix; a general memory-profiling overhaul for nx-t9wlb (this
  proposal adds diagnosability, not a guaranteed root-cause fix for a crash whose exact trigger
  is still unconfirmed — see Risks)

## Testing
| Affected seam | Unit task | E2E task |
|----------------|-----------|----------|
| Agent memory/crash diagnosability | N/A — infra logging change | [4.1] verify structured memory-pressure log line appears under simulated load |
| PTY viewer geometry race | N/A — Swift client change | [4.2] manual/scripted attach-then-immediately-write repro, confirm no garble |
| `server-health-handler.ts` disk aggregation | [4.3] unit test: multi-disk system via server-health-handler matches health-scheduler's output | N/A |
| `reaper-persistence.test.ts` isolation | [4.4] regression: test passes regardless of declaration order | N/A |
| PG-gated cross-contamination | [4.5] full-suite run under NEXUS_HEAVY_TESTS+NEXUS_PG_TESTS, 0 unexpected failures | N/A |
| bun.lock drift recovery | N/A | [4.6] simulate frozen-install failure, confirm hook recovers or surfaces actionable error |
| Non-primary migration skip | [4.7] unit test: 03-migrate hook exits early on a non-primary-flagged machine | N/A |

## Impact
| Area | Change |
|------|--------|
| `apps/agent/src/` (agent process) | +structured memory-pressure logging |
| `apps/swift/nexus-mac/.../PtyViewer.swift` | attach-handshake geometry ordering fix |
| `apps/agent/src/server-health-handler.ts` | import + call `aggregateDiskPercent()`, remove inline duplicate |
| `apps/agent/src/services/reaper-persistence.test.ts` | per-test cleanup |
| PG-gated test files | mock isolation fix |
| `deploy/hooks.d/post-merge/02-deploy`, `03-migrate` | lockfile-drift recovery, non-primary skip |

## Risks
| Risk | Mitigation |
|------|-----------|
| nx-t9wlb's exact crash trigger is not fully root-caused (no kernel OOM-kill logged) | Scope limited to diagnosability (structured logging), not a guaranteed fix; escalate with new data if crashes recur post-fix |
| Non-primary migration skip could mask a genuine future need to migrate from a secondary host | Skip condition is machine-role-based (primary-writer flag), not blanket — an operator can still force migration manually |

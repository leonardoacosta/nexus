# Proposal: Session row enrichment — project + rich metadata

## Change ID

session-row-enrichment-v1

## Why

The Nexus.app SessionsView surfaces a row per active CC session, but every
row currently renders `— claude · active pinned` with no project,
no branch, no cost, no path, no duration. Verified 2026-05-20 via
screenshot: three concurrent sessions all show identical dashes.

Root cause is two-layered:

1. **Agent never resolves project**: `apps/agent/src/services/process-watcher.ts:224`
   hard-codes `projectId: null` on every new row despite capturing `cwd`
   two lines earlier at line 217. The approved-but-unapplied
   `add-git-project-resolver` spec (2026-05-17) would have populated
   `gitOwnerRepo`/`gitProvider` on the session_start hook path — but
   process-watcher is a separate ingest path and isn't covered.
2. **Swift row ignores rich wire fields**: the agent emits 26 fields per
   session including `branch`, `cwd`, `totalCostUsd`, `idleSince`,
   `startedAt`, `spec`, `tmuxTarget`, `gitOwnerRepo`, `gitProvider`,
   `rateLimitUtilization`. The current `SessionRow` Swift view renders
   only `project`/`branch`/`model`/`status`/`originAgent` — and `project`
   is always nil because of bug #1.

This spec supersedes `add-git-project-resolver` (closes it as superseded)
and ships both layers together as one coherent UX improvement.

## What Changes

### Agent (resolver + ingest paths)

1. **Create `apps/agent/src/services/git-project-resolver.ts`** —
   `resolveProject(cwd: string): Promise<{provider, ownerRepo, projectId} | null>`.
   Runs `git remote get-url origin` in the cwd via Bun's `$` shell.
   Parses output into provider (`github`|`azure-devops`|`gitlab`|`bitbucket`)
   and `owner/repo`. Cross-references the project-registry table to derive
   the canonical `projectId`. Cache results per cwd for 30s (avoid re-shell
   on every poll).

2. **Wire resolver into `process-watcher.ts`** — replace the hard-coded
   `projectId: null` at line 224 with a call to the resolver. Populate
   `gitOwnerRepo`, `gitProvider`, `projectId` on the snapshot before
   `upsert`.

3. **Wire resolver into the session_start hook** in `apps/agent/src/routes/hooks.ts`
   (or wherever hook ingest creates the session row). Same call site,
   same enrichment.

4. **Schema columns already exist** on the `sessions` table OR are
   covered by the `add-git-project-resolver` migration if not. Verify
   on disk via `\d sessions` against homelab PG; ship the migration if
   absent.

### Swift (SessionRow redesign)

5. **Redesign `SessionsView.swift` row** to surface:
   - **Top line (leading)**: project label — prefer `gitOwnerRepo`
     (e.g. `leonardoacosta/oo`), else `projectId`, else `cwd` basename,
     else `—`. Then `·` then branch if present.
   - **Top line (trailing)**: status pill (active/idle/ended) + pinned
     chip (keep existing semantics).
   - **Bottom line (leading)**: cwd directory tail · model · cost
     (`$0.42` from totalCostUsd) · idle time (`12m idle` from idleSince).
   - **Bottom line (trailing)**: PID · originAgent (machine).
   - Hidden fields (still in model): tmuxTarget, ccSessionId, spec,
     rateLimitUtilization — exposed via row hover / detail view in a
     future spec.

### Tests

6. **Agent contract test** — `git-project-resolver.test.ts` with
   git-remote fixture tmpdirs (4 providers).
7. **Process-watcher test extension** — verify resolver call site
   populates the three new fields when cwd has a git remote.
8. **Swift SessionRow snapshot test** (or unit) — verify each field
   degradation chain (gitOwnerRepo → projectId → cwd basename → dash).

## Context

- supersedes: `add-git-project-resolver` (approved 2026-05-17, never applied — covered by this spec's broader scope)
- depends on: (none)
- touches: `apps/agent/src/services/git-project-resolver.ts`, `apps/agent/src/services/process-watcher.ts`, `apps/agent/src/routes/hooks.ts`, `apps/agent/src/services/git-project-resolver.test.ts`, `apps/agent/src/services/process-watcher.test.ts`, `apps/swift/nexus-mac/Sources/Dashboard/SessionsView.swift`, `apps/swift/NexusShared/Models/Session.swift`, `apps/swift/NexusSharedTests/SessionRowTests.swift`, `packages/db/drizzle/00XX_sessions_git_columns.sql`

## Motivation

The Sessions tab is the highest-traffic surface in Nexus.app — Leo glances
at it dozens of times per day to triage active CC work. A wall of
identical `— claude · active pinned` rows is functionally useless.
The wire data is already 90% there; the agent just doesn't fill the
project fields and Swift doesn't show what IS there.

## Locked Decisions

- **Project resolution at ingest, not query time** — write once on
  session_start (hook) or first poll (process-watcher), don't re-resolve
  on every `/sessions` fetch.
- **Cache 30s by cwd** — git remote rarely changes; this avoids spawning
  a subprocess per session per poll cycle.
- **Resolver fail-soft** — if `git remote` fails or cwd isn't a repo,
  emit null for all three fields and continue. No row blocking.
- **Row layout: two lines, dense** — matches the existing menu-bar
  density. No avatars, no large project icons. ASCII chips for status.
- **Cost format `$N.NN`** — two decimals, dollar sign. Null cost
  displays nothing (not `$0.00` — too noisy).
- **Idle threshold display** — show `Nm idle` when `idleSince` set;
  otherwise show duration since `startedAt` as `Nm` or `Nh`.

## Out of Scope

- Multi-agent aggregation tweaks (the current aggregate already merges
  rows correctly).
- Session detail view / clickthrough (already wired via existing tap
  handler; this spec keeps it).
- Cost rollup across sessions per project (separate spec).
- Project-registry CRUD UI (separate spec).
- Rate-limit utilization indicator (deferred to a future spec — wire
  field already populated by credentials-rich-emission's tracker).

# Tasks: session-row-enrichment-v1

<!-- beads:epic:nx-vuw7a -->
<!-- beads:feature:nx-0aso6 -->

## API Batch

- [x] [1.1] Inspect homelab PG: `ssh nyaptor@100.73.182.4 'psql $POSTGRES_URL -c "\d sessions"'`. Confirm whether `git_provider` and `git_owner_repo` columns exist (per add-git-project-resolver spec they were planned). If absent, generate Drizzle migration `bun drizzle-kit generate --custom --name sessions-git-columns` and hand-edit SQL [owner:db-engineer] [type:db] [beads:nx-vrr1w]
- [x] [1.2] [P-1] Create `apps/agent/src/services/git-project-resolver.ts` — `resolveProject(cwd: string): Promise<{provider, ownerRepo, projectId} | null>`. Uses Bun `$\`git -C \${cwd} remote get-url origin\`` (no shell injection). Parses URL into provider + owner/repo. Cross-references project-registry table via existing project-registry service for projectId. 30s in-memory cache by cwd [owner:api-engineer] [type:feature] [beads:nx-hqwb0]
- [x] [1.3] [P-1] URL-parser for 4 providers: github.com, dev.azure.com / *.visualstudio.com, gitlab.com, bitbucket.org. Both HTTPS and SSH forms (`git@github.com:foo/bar.git`). Trailing `.git` stripped from ownerRepo [owner:api-engineer] [type:feature] [beads:nx-bspjq]
- [x] [1.4] Hook resolver into `apps/agent/src/services/process-watcher.ts:224` — replace `projectId: null` with `await gitProjectResolver.resolveProject(cwd)`. Populate all three fields on the snapshot before upsert. Watcher's reconcileOnce loop should re-enrich existing null-project rows on subsequent polls [owner:api-engineer] [type:feature] [beads:nx-63ilg]
- [x] [1.5] [P-2] Hook resolver into the session_start hook path in `apps/agent/src/routes/hooks.ts` (or wherever hook ingest creates the session row). Same enrichment call, same fail-soft semantics [owner:api-engineer] [type:feature] [beads:nx-ph2d7]
- [x] [1.6] [P-2] Update `packages/db/src/schema/sessions.ts` if columns added in 1.1 — add `gitProvider`, `gitOwnerRepo` fields [owner:db-engineer] [type:db] [beads:nx-i55iu]
- [x] [1.7] Add `apps/agent/src/services/git-project-resolver.test.ts` with 5 tests: github HTTPS URL, github SSH URL, Azure DevOps URL, missing-git-repo (returns null), cache hit within 30s [owner:api-engineer] [type:test] [beads:nx-e2xej]
- [x] [1.8] Extend `apps/agent/src/services/process-watcher.test.ts` to assert resolver call site populates the three fields when cwd has a git remote [owner:api-engineer] [type:test] [beads:nx-sm52r]

## UI Batch

- [x] [2.1] Update `apps/swift/NexusShared/Models/Session.swift` if the model is missing `gitProvider`/`gitOwnerRepo`/`totalCostUsd`/`idleSince` fields. Decode as optional types with snake_case CodingKeys matching the wire shape [owner:ui-engineer] [type:types] [beads:nx-5wyto]
- [x] [2.2] [P-1] Restructure `apps/swift/nexus-mac/Sources/Dashboard/SessionsView.swift` `SessionRow` view: two-line layout, primary line with project label + branch, trailing column with status/pinned chips. Implement the project-label degradation chain (gitOwnerRepo → projectId → cwd basename → dash) [owner:ui-engineer] [type:feature] [beads:nx-8gkci]
- [x] [2.3] [P-1] Add secondary-line rendering: model · cost · idle/duration. Cost omitted when null/zero. Idle shows `Nm idle` when idleSince set, else `Nm`/`Nh` since startedAt [owner:ui-engineer] [type:feature] [beads:nx-61lt4]
- [x] [2.4] [P-2] Add trailing-column muted text for `pid · originAgent` below the status chips. Compact monospace, secondary color [owner:ui-engineer] [type:feature] [beads:nx-kfaqb]
- [x] [2.5] [P-2] Verify the existing tap handler (session detail navigation) still fires on the redesigned row. No regressions to click-target [owner:ui-engineer] [type:test] [beads:nx-otiu4]

## E2E Batch

- [x] [3.1] Add `apps/swift/NexusSharedTests/SessionRowTests.swift` — 4 tests: gitOwnerRepo-present renders owner/repo, projectId-only renders projectId, cwd-only renders basename, all-null renders dash. Cost/idle degradation tested separately [owner:ui-engineer] [type:test] [beads:nx-l1agm]
- [ ] [3.2] Push + ssh-pull homelab: hook chain runs bun install (if needed), 02-deploy rebuilds, agent restarts. Verify via `curl /sessions` that gitOwnerRepo / gitProvider are populated on active rows (your 3 active sessions in `/home/nyaptor/dev/oo` should show `leonardoacosta/oo`). **STILL BLOCKED — new root cause** (push 9c3ac6c + 23268dd + a4-cleanup shipped a code-side fix that reads `/proc/<pid>/cwd` for empty-cwd rows). Debug logging under the homelab daemon revealed `freshCwd: null` — i.e. `readlinkSync` returns EACCES inside the systemd unit because `ProtectHome=read-only` + `ProtectSystem=strict` mask /proc/<pid>/cwd symlinks pointing into /home. Confirmed via `systemd-run --user --property=ProtectHome=read-only --property=ProtectSystem=strict bun /tmp/test.ts` reproducing the EACCES. **Fix scope expanded** to `deploy/nexus-agent.service` — needs `ProtectHome=off` (or relaxed) before code-side recovery can work. NOT inside this beadwork (nx-lebux). Filing follow-up issue [owner:devops-engineer] [type:test] [beads:nx-cc4kj]
- [x] [3.3] Mac post-merge: `deploy/hooks.d/post-merge/04-swift-deploy --force` rebuilds Nexus.app. BUILD SUCCEEDED. nx-4l66v hook bug workaround applied (kill -9 + open -ga). PID change verified: 99359 → 49624 [owner:devops-engineer] [type:test] [beads:nx-djdq3]
- [x] [3.4] [user] Verification recipe for Leo: (1) Open Nexus.app from `/Applications/Nexus.app` (PID 49624, rebuilt 2026-05-20 21:30 CDT). (2) Click the menu-bar icon, open the Sessions tab. (3) For each active session row, confirm the row shows two lines plus a trailing column:
  - TOP line: `<project label> · <branch>` where project label is `owner/repo` (e.g. `leonardoacosta/oo`) when gitOwnerRepo is set, else projectId, else cwd basename, else `—`.
  - BOTTOM line: `<model> · $<cost> · <Nm idle | Nm | Nh>`. Cost segment omitted when null/zero.
  - TRAILING column: `<status>` chip + muted `pid <N> · <machine>` underneath.
  (4) Capture a screenshot to `docs/screenshots/session-row-enrichment-v1-mac.png` for the audit trail. NOTE: blocked-pending nx-lebux — active rows on homelab currently show empty primary label because process-watcher skips re-enrichment when cwd is empty (regression filed). Re-run verification after nx-lebux ships [user] [owner:user] [type:test] [beads:nx-lm57x]
- [x] [3.5] Mark `add-git-project-resolver` spec as superseded — feature bead nx-tgn1e already closed 2026-05-18 (verified `bd show nx-tgn1e`: status=closed, reason cites add-git-project-resolver shipped). Archived spec dir to `openspec/changes/archive/2026-05-20-add-git-project-resolver-superseded/` (git-tracked rename) [owner:devops-engineer] [type:docs] [beads:nx-zjuhu]
- [x] [3.6] Update `openspec/specs/session-persistence/spec.md` AND `openspec/specs/swift-menubar-client/spec.md` post-archive [handled by Phase 4 archive] — orchestrator's openspec archive step will update both spec files automatically when this change is archived [owner:devops-engineer] [type:docs] [beads:nx-x3j6u]

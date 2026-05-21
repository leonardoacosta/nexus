# Tasks: session-row-enrichment-v1

<!-- beads:epic:nx-vuw7a -->
<!-- beads:feature:nx-0aso6 -->

## API Batch

- [x] [1.1] Inspect homelab PG: `ssh nyaptor@100.73.182.4 'psql $POSTGRES_URL -c "\d sessions"'`. Confirm whether `git_provider` and `git_owner_repo` columns exist (per add-git-project-resolver spec they were planned). If absent, generate Drizzle migration `bun drizzle-kit generate --custom --name sessions-git-columns` and hand-edit SQL [owner:db-engineer] [type:db] [beads:nx-vrr1w]
- [ ] [1.2] [P-1] Create `apps/agent/src/services/git-project-resolver.ts` — `resolveProject(cwd: string): Promise<{provider, ownerRepo, projectId} | null>`. Uses Bun `$\`git -C \${cwd} remote get-url origin\`` (no shell injection). Parses URL into provider + owner/repo. Cross-references project-registry table via existing project-registry service for projectId. 30s in-memory cache by cwd [owner:api-engineer] [type:feature] [beads:nx-hqwb0]
- [ ] [1.3] [P-1] URL-parser for 4 providers: github.com, dev.azure.com / *.visualstudio.com, gitlab.com, bitbucket.org. Both HTTPS and SSH forms (`git@github.com:foo/bar.git`). Trailing `.git` stripped from ownerRepo [owner:api-engineer] [type:feature] [beads:nx-bspjq]
- [ ] [1.4] Hook resolver into `apps/agent/src/services/process-watcher.ts:224` — replace `projectId: null` with `await gitProjectResolver.resolveProject(cwd)`. Populate all three fields on the snapshot before upsert. Watcher's reconcileOnce loop should re-enrich existing null-project rows on subsequent polls [owner:api-engineer] [type:feature] [beads:nx-63ilg]
- [ ] [1.5] [P-2] Hook resolver into the session_start hook path in `apps/agent/src/routes/hooks.ts` (or wherever hook ingest creates the session row). Same enrichment call, same fail-soft semantics [owner:api-engineer] [type:feature] [beads:nx-ph2d7]
- [ ] [1.6] [P-2] Update `packages/db/src/schema/sessions.ts` if columns added in 1.1 — add `gitProvider`, `gitOwnerRepo` fields [owner:db-engineer] [type:db] [beads:nx-i55iu]
- [ ] [1.7] Add `apps/agent/src/services/git-project-resolver.test.ts` with 5 tests: github HTTPS URL, github SSH URL, Azure DevOps URL, missing-git-repo (returns null), cache hit within 30s [owner:api-engineer] [type:test] [beads:nx-e2xej]
- [ ] [1.8] Extend `apps/agent/src/services/process-watcher.test.ts` to assert resolver call site populates the three fields when cwd has a git remote [owner:api-engineer] [type:test] [beads:nx-sm52r]

## UI Batch

- [ ] [2.1] Update `apps/swift/NexusShared/Models/Session.swift` if the model is missing `gitProvider`/`gitOwnerRepo`/`totalCostUsd`/`idleSince` fields. Decode as optional types with snake_case CodingKeys matching the wire shape [owner:ui-engineer] [type:types] [beads:nx-5wyto]
- [ ] [2.2] [P-1] Restructure `apps/swift/nexus-mac/Sources/Dashboard/SessionsView.swift` `SessionRow` view: two-line layout, primary line with project label + branch, trailing column with status/pinned chips. Implement the project-label degradation chain (gitOwnerRepo → projectId → cwd basename → dash) [owner:ui-engineer] [type:feature] [beads:nx-8gkci]
- [ ] [2.3] [P-1] Add secondary-line rendering: model · cost · idle/duration. Cost omitted when null/zero. Idle shows `Nm idle` when idleSince set, else `Nm`/`Nh` since startedAt [owner:ui-engineer] [type:feature] [beads:nx-61lt4]
- [ ] [2.4] [P-2] Add trailing-column muted text for `pid · originAgent` below the status chips. Compact monospace, secondary color [owner:ui-engineer] [type:feature] [beads:nx-kfaqb]
- [ ] [2.5] [P-2] Verify the existing tap handler (session detail navigation) still fires on the redesigned row. No regressions to click-target [owner:ui-engineer] [type:test] [beads:nx-otiu4]

## E2E Batch

- [ ] [3.1] Add `apps/swift/NexusSharedTests/SessionRowTests.swift` — 4 tests: gitOwnerRepo-present renders owner/repo, projectId-only renders projectId, cwd-only renders basename, all-null renders dash. Cost/idle degradation tested separately [owner:ui-engineer] [type:test] [beads:nx-l1agm]
- [ ] [3.2] Push + ssh-pull homelab: hook chain runs bun install (if needed), 02-deploy rebuilds, agent restarts. Verify via `curl /sessions` that gitOwnerRepo / gitProvider are populated on active rows (your 3 active sessions in `/home/nyaptor/dev/oo` should show `leonardoacosta/oo`) [owner:devops-engineer] [type:test] [beads:nx-cc4kj]
- [ ] [3.3] Mac post-merge: `deploy/hooks.d/post-merge/04-swift-deploy --force` rebuilds Nexus.app. Force-kill + relaunch (nx-4l66v hook bug workaround). Verify rebuild via PID change [owner:devops-engineer] [type:test] [beads:nx-djdq3]
- [ ] [3.4] [user] Open Nexus.app dashboard Sessions tab. Confirm rows now show: project label (owner/repo or project), branch if any, model, cost, idle/duration, pid, machine. Capture screenshot for audit trail [user] [owner:user] [type:test] [beads:nx-lm57x]
- [ ] [3.5] Mark `add-git-project-resolver` spec as superseded — close its feature bead with reason "superseded by session-row-enrichment-v1", archive its spec dir as `archive/2026-05-XX-add-git-project-resolver-superseded` [owner:devops-engineer] [type:docs] [beads:nx-zjuhu]
- [ ] [3.6] Update `openspec/specs/session-persistence/spec.md` AND `openspec/specs/swift-menubar-client/spec.md` post-archive [handled by Phase 4 archive] [owner:devops-engineer] [type:docs] [beads:nx-x3j6u]

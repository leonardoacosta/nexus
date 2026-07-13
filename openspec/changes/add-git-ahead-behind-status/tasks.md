<!-- beads:epic:nx-dkwmk -->
<!-- beads:feature:nx-syj5i -->

# Tasks: add-git-ahead-behind-status

## DB Batch

- [x] 1.1 No schema change. `git_events`/`project_status_snapshots` tables are unaffected — the [beads:nx-a68pm]
      new fields live only in the observer's in-memory `GitStatusObject`, not persisted.
      - touches: (none)

## API Batch

- [ ] 2.1 Add `ahead: z.number().int().nonnegative()` and `behind: z.number().int().nonnegative()` [beads:nx-t0us6]
      to `gitStatusObject` in `packages/core/src/types/git-status.ts`, updating the doc comment
      to describe the new fields (default 0/0 when no upstream).
      - touches: `packages/core/src/types/git-status.ts`
- [ ] 2.2 Extend `parseGitStatusV2` in `apps/agent/src/services/git-observer.ts` to parse the [beads:nx-ww0dl]
      `# branch.ab +X -Y` line into `ahead`/`behind`, mirroring the regex already used by
      `parseGitMetadata` in `apps/agent/src/services/git-project.ts`
      (`/^\+(-?\d+)\s+-(-?\d+)$/` against the text after `# branch.ab `). Default to `0`/`0`
      when the line is absent. Update `GitObservation` usage sites (the `observedState` map
      value) to carry the new fields — no other code changes needed since `GET
      /projects/:id/status` folds the observer's state through unchanged.
      - touches: `apps/agent/src/services/git-observer.ts`
      - depends on: (none — task 2.1 lands first within this same batch)
- [ ] 2.3 Unit tests in `apps/agent/src/services/git-observer.test.ts`: `parseGitStatusV2` with a [beads:nx-qy5ab]
      `# branch.ab +3 -1` line returns `ahead: 3, behind: 1`; without the line returns
      `ahead: 0, behind: 0`.
      - touches: `apps/agent/src/services/git-observer.test.ts`
- [ ] 2.4 Integration test in `apps/agent/src/routes/project-status.test.ts`: an observed project [beads:nx-vu6dk]
      with a simulated ahead/behind state returns `git.ahead`/`git.behind` in the
      `GET /projects/:id/status` response.
      - touches: `apps/agent/src/routes/project-status.test.ts`

## UI Batch

- [ ] 3.1 No UI change in this proposal — no consumer of the new fields exists yet. (Non-goal, [beads:nx-93lqs]
      see proposal.md.)
      - touches: (none)

## E2E Batch

- [ ] 4.1 No E2E change — backend data-shape addition only, no user-facing flow to exercise. [beads:nx-oeful]
      - touches: (none)

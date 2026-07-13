# Proposal: Git Status Orbit (revive git-event-store on Postgres)

## Change ID

`add-git-status-orbit`

## Summary

Revive the committed-but-dead `git-event-store` capability (SQLite-era, Rust implementation lost
in v2) on the Bun agent + Postgres: a 60-second staggered poller observes each locally-registered
project's git state (branch, HEAD sha, dirty summary), persists branch-switch / new-commit /
detached-head transitions to an append-only `git_events` table, and folds the current git state
into the project status payload. Completes Nexus's role as orbiter of static project status.

## Context

- depends on: `add-project-status-snapshots`, `add-session-context-api`
- touches: `packages/db/src/schema/gitEvents.ts`, `packages/db/src/schema/index.ts`, `apps/agent/src/db/retention.ts`, `packages/core/src/types/git-status.ts`, `packages/core/src/index.ts`, `apps/agent/src/services/git-observer.ts`, `apps/agent/src/routes/project-status.ts`, `apps/agent/src/server-request-handler.ts`, `apps/agent/src/index.ts`

`add-project-status-snapshots` is a genuine soft dependency: this change extends the
`GET /projects/:id/status` payload and route file that proposal introduces, and shares
`server-request-handler.ts` + `retention.ts` touches. `add-session-context-api` is the route
convention template both follow.

## Motivation

- `git-event-store`'s committed requirement ("the git watch service MUST write branch switch,
  new commit, and detached head events to the `git_events` table") has had no implementation
  since the v2 rewrite — a zombie spec.
- Consumers currently each shell out to git themselves: nexus-statusline per render
  (`index.ts:84-101`), cc-tmux per pane state transition. Those hot paths are correct and STAY
  local (they render for the session's cwd — often a worktree — local git is ~10ms and works
  when the agent is down). What is missing is the orbital view: cross-machine, queryable,
  historical git state per registered project, served by the agent that already owns project
  registry + status data.
- Queued consumer nx-yn6c2 (cc-tmux querying nx context endpoints) points at this payload.

## Requirements (canonical text in `specs/` delta)

1. **Event persistence revived on Postgres** (MODIFIED): branch_switch / new_commit /
   detached_head transitions inserted into `git_events` (Drizzle schema, migration-based only —
   never `db:push`), 90d retention.
2. **Poll-based observation** (ADDED): 60s staggered poll over locally-present registered
   project locations using git plumbing; fail-open per project (missing git, not a repo, bare
   repo → project skipped, others unaffected). No fs.watch — dirty state is working-tree-wide
   and cannot be observed via `.git/` events alone; poll cadence is sufficient for orbital data
   (see design.md).
3. **Current git state served** (ADDED): the project status payload gains a `git` object
   (branch, headSha, detached, dirty file counts, observedAt) from the observer's in-memory
   current state; `GET /projects/:id/git-events?days=` serves the persisted event history.
   Contracts in `packages/core/src/types/git-status.ts`.

## Scope

- In: `git_events` schema + migration, retention, git-observer service (poll, transition
  detection, in-memory current state), status payload extension, git-events history route,
  core Zod contracts, tests.
- Out: statusline/cc-tmux consumption (hot paths stay local — nx-yn6c2 is a separate follow-up),
  worktree-level observation (project root locations only), lifecycle-bus event for git
  transitions (future, if a live dashboard surface wants it), any cc-side changes, backfill
  of historical git log into events.

## Testing

| Seam | Coverage |
| --- | --- |
| Transition detection (branch switch, new commit, detached head, first-observation baseline) | Unit tests, task 4.1 |
| Fail-open on non-repo / missing location / git absent | Unit tests, task 4.1 |
| Staggered poll batching + AbortController teardown | Unit tests, task 4.1 |
| `git` object in status payload + absent-when-unobserved | Route tests (PG-gated), task 4.2 |
| GET /projects/:id/git-events days window + 404 unknown project | Route tests (PG-gated), task 4.2 |
| Retention prune of git_events | Extend retention tests, task 4.2 |

## Impact

- New table: `git_events` (+ one generated migration). New service: `git-observer.ts` wired in
  `apps/agent/src/index.ts` startup alongside the existing schedulers.
- `routes/project-status.ts` (from `add-project-status-snapshots`) gains the `git` payload field
  and the git-events dispatch — serialized behind that proposal by the declared dependency.

## Risks

- `git status --porcelain` cost on very large repos at 60s cadence — mitigated by staggered
  batches (spec-watcher's batching shape) and per-project timeout with fail-open skip.
- Multi-location projects: each agent observes only locations on its own machine; consumers
  aggregating across machines see per-agent state, which is the existing peer-to-peer topology's
  semantics, not a new inconsistency.
- Detached-head worktrees at the registered root produce `detached=true` rather than a branch —
  covered by an explicit scenario.

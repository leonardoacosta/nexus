# Add ahead/behind counts to git-status-orbit

## Context

Originated from `/openspec:explore` (2026-07-13) investigating git-status endpoint gaps. The
`add-git-status-orbit` capability (`git-event-store`) already polls every registered project
every 60s via `git status --porcelain=v2 --branch`, folding the result into
`GET /projects/:id/status` as a `git` object (branch, headSha, detached, dirty). That poll
already receives ahead/behind data in its own output (the `# branch.ab +X -Y` line, emitted
whenever an upstream is configured) but the parser (`parseGitStatusV2` in
`apps/agent/src/services/git-observer.ts`) explicitly discards every `#`-prefixed line except
`# branch.oid` and `# branch.head` — so the data is thrown away for free every poll cycle.

A separate, older, on-demand path already parses this exact line correctly:
`apps/agent/src/services/git-project.ts`'s `parseGitMetadata` (backing `GET /projects`
`git_metadata`) reads `# branch.ab +X -Y` into `ahead`/`behind` ints via a small regex. This
proposal ports that regex into the observer's parser rather than reinventing it, and does NOT
touch `git-project.ts` or its endpoint — that path keeps working as-is, this only extends the
periodic-poll path that currently lacks the field.

- touches: `packages/core/src/types/git-status.ts`, `apps/agent/src/services/git-observer.ts`

## What Changes

- Add `ahead`/`behind` (non-negative integers, default 0 when no upstream is configured) to
  `GitStatusObject`/`gitStatusObject` in `packages/core/src/types/git-status.ts`, mirroring the
  existing `GitDirtyCounts` sub-object style.
- Extend `parseGitStatusV2` in `apps/agent/src/services/git-observer.ts` to parse the
  `# branch.ab +X -Y` line (same regex `parseGitMetadata` already uses in `git-project.ts`),
  populating the new fields. Absent line (no upstream) → `ahead: 0, behind: 0`.
- No new git subprocess: the observer's existing single `git status --porcelain=v2 --branch`
  call per poll already emits this line when applicable.
- `GET /projects/:id/status`'s `git` field picks up the new fields automatically — no route
  change needed, since it folds the observer's in-memory state through unchanged.

## Non-Goals

- No change to `git_events` transition/event-log semantics. `branch_switch` / `new_commit` /
  `detached_head` stay the only event types — an "ahead/behind changed" event is a separate,
  unasked-for scope expansion and is explicitly out of scope here.
- No change to `git-project.ts` / `GET /projects` `git_metadata` (the older on-demand path) —
  it already has ahead/behind correctly and is untouched.
- No change to `apps/agent/src/routes/statusline.ts`'s separate `fetchGitStatus()` ahead/behind
  computation, or to `apps/nexus-statusline`'s own local git shell-out — those are independent
  consumers/producers outside this capability's scope; a follow-up could later have them
  consume the observer's data instead of shelling out themselves, but that is not requested here.

## Testing

- Unit: `parseGitStatusV2` given porcelain-v2 output with a `# branch.ab +3 -1` line returns
  `ahead: 3, behind: 1`; given output with no `# branch.ab` line (no upstream) returns
  `ahead: 0, behind: 0` — see `apps/agent/src/services/git-observer.test.ts` (extend existing
  suite; mirrors `git-project.test.ts`'s existing ahead/behind coverage for `parseGitMetadata`).
- Integration: `GET /projects/:id/status` for an observed project with a configured upstream
  ahead of it includes `git.ahead > 0` in the response — see
  `apps/agent/src/routes/project-status.test.ts`.
- No E2E/UI seam — this is a backend data-shape addition with no consuming UI yet.

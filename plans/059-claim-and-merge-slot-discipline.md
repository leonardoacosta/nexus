# Plan 059: Concurrency discipline — `bd ready --claim` + merge-slot around the sync window

> **Executor instructions**: Follow this plan step by step, run every
> verification command, honor STOP conditions, and update this plan's row in
> `plans/README.md` when done. This plan writes a script + docs; it runs NO
> bd write commands itself.
>
> **Drift check (run first)**:
> `git diff --stat 9c4c61ed..HEAD -- AGENTS.md scripts/`
> On managed-block or protocol-section changes, re-read before editing.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (a wrapper script + protocol text; failure degrades to today's behavior)
- **Depends on**: none (pairs naturally with 058's memory seeding)
- **Category**: workflow-gap (multi-session concurrency)
- **Planned at**: commit `9c4c61ed`, 2026-07-19

## Why this matters

Multiple CC sessions run concurrently on this repo across two machines, and
the collision artifacts are already in git history: `3d023850 chore(beads):
flush export (nx-ev2x5.1 closed by concurrent session)` — one session's
close raced another's flush. The AGENTS.md session protocol
(`git pull --rebase` → `bd dolt push` → `git push`) is the conflict-prone
window: two sessions running it simultaneously contend on both the Dolt
remote and the git remote.

bd 1.1.0 ships the primitives for exactly this:

- `bd update <id> --claim` / `bd ready --claim --json` — atomic
  first-claim-wins assignment (assignee + in_progress in one op), so two
  sessions cannot pick up the same bead.
- `bd merge-slot create|acquire|release|check` — a one-per-repo exclusive
  lock designed to serialize conflict-prone windows.

Neither appears anywhere in AGENTS.md, scripts/, or the workflow docs
(AGENTS.md says `bd update <id> --claim` in its Quick Reference table but
the Session Completion protocol never references claiming or
serialization). This plan encodes both — as a wrapper script agents can run
plus protocol text — without touching agent daemon code.

## Current state

`AGENTS.md` Session Completion (outside the managed block), current
mandatory workflow:

```
1. **File issues for remaining work** ...
2. **Run quality gates** ...
3. **Update issue status** ...
4. **PUSH TO REMOTE** - This is MANDATORY:
   git pull --rebase
   bd dolt push
   git push
   ...
```

`scripts/` contains repo tooling (`hooks/pre-commit-block-db-push.sh`,
`lint-sql-safety.sh` etc.) — follow their shell style (shebang, `set -euo
pipefail` if used — read two of them first and match).

## Steps

### Step 1 — Read the merge-slot contract

Fetch/read `bd merge-slot --help` (read-only) to confirm subcommand names,
lock semantics (TTL? stale-lock behavior? holder identity?), and exit
codes. The docs (multi-agent/coordination) describe create/check/acquire/
release. If `--help` shows a TTL/force-release mechanism, incorporate it
into Step 2's stale-lock handling. If the subcommand does not exist in the
installed bd (version skew), STOP and report.

### Step 2 — `scripts/bd-session-end.sh`

A wrapper encoding the serialized sync window:

```sh
#!/usr/bin/env sh
# Serialized session-end sync (plan 059). Acquires the repo's bd merge-slot
# so concurrent CC sessions can't interleave pull/dolt-push/push windows
# (the nx-ev2x5.1 "closed by concurrent session" class).
set -eu

SLOT="session-end-sync"

bd merge-slot acquire "$SLOT" || {
  echo "bd-session-end: merge-slot busy — another session is syncing." >&2
  echo "Re-run when it completes (bd merge-slot check $SLOT)." >&2
  exit 75   # EX_TEMPFAIL
}
trap 'bd merge-slot release "$SLOT"' EXIT

git pull --rebase
bd dolt push
git push
git status --short --branch
```

Adapt to the REAL acquire/release syntax from Step 1 (slot naming, whether
`create` must precede `acquire`, holder args). Non-interactive flags per
AGENTS.md's own shell rules. `chmod +x`.

### Step 3 — Protocol text

In AGENTS.md, OUTSIDE the managed markers:

- Replace the raw three-command block in "PUSH TO REMOTE" with
  `./scripts/bd-session-end.sh` (keep the raw commands listed as the
  fallback when bd is absent, since the script degrades hard on missing
  merge-slot support).
- In the Quick Reference / claiming guidance, make claiming the default:
  "Pick work with `bd ready --claim --json` (atomic; prevents two sessions
  grabbing the same bead) rather than `bd ready` + manual update."
- One sentence on WHY (the nx-ev2x5.1 collision), so future edits don't
  strip it as ceremony.

### Step 4 — Tests

`deploy/tests/` contains shell tests (e.g.
`post-merge-hook-order.test.sh`) — follow that harness style. Add
`deploy/tests/bd-session-end.test.sh` (or scripts/tests/ if that's the
local convention — check where existing script tests live; `exec.test.ts`
suggests utils are TS-tested, but this is a shell script):

1. with a stubbed `bd` on PATH whose `merge-slot acquire` exits 1 → script
   exits 75 and runs NO git commands (stub `git` too, assert not called);
2. acquire succeeds → commands run in order → release called on exit;
3. release fires even when `git push` fails (trap coverage).

Verification: run the new test script; expected exit 0.

## Done criteria (machine-checkable)

- `test -x scripts/bd-session-end.sh` → true.
- Stub-based test proves: busy-slot → no git ops; failure → release still
  fires.
- `grep -c "bd-session-end.sh" AGENTS.md` → ≥ 1;
  `grep -c "ready --claim" AGENTS.md` → ≥ 1.
- AGENTS.md managed block untouched (`git diff` outside markers only).

## Out of scope — do not touch

- Agent daemon code (this is operator/agent-session tooling).
- Auto-running the script from git hooks (session end is an agent decision,
  not a git event).
- Creating the merge-slot in the live db (`bd merge-slot create` may be
  needed once — OPERATOR action; list it in the report and
  plans/README.md operator-actions if Step 1 shows create-before-acquire
  is required).

## STOP conditions

- `bd merge-slot` absent from installed bd 1.1.0 → STOP, report (docs vs
  binary skew; the claim-guidance half of the plan can still land —
  deliver Steps 3's claim text + report).
- If AGENTS.md's protocol section turns out to be INSIDE a managed marker
  block at HEAD (re-check), put the text in a new unmanaged section and
  reference it.

## Maintenance notes

- If plan 061 (molecules) lands, wave agents should claim via
  `bd ready --mol <id> --claim` — same primitive, molecule-scoped.
- The merge-slot serializes bd+git sync, not code edits; worktree isolation
  still owns that.
- Watch bd release notes for native session-end helpers; this script is
  deletable the day bd ships one.

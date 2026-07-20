# Plan 055: One shared "ready" derivation across all bead surfaces + reconcile the stale spec

> **Executor instructions**: Follow this plan step by step, run every
> verification command, honor STOP conditions, and update this plan's row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 9c4c61ed..HEAD -- apps/agent/src/services/bead-rollup.ts apps/agent/src/routes/pulse.ts apps/agent/src/lib/fleet-exceptions.ts apps/agent/src/routes/project-detail.ts openspec/specs/bead-proposal-roadmap/spec.md`
> **Expected drift**: the in-flight openspec change `async-agent-hot-path-reads`
> converts `resolveTasksMd` in `bead-rollup.ts` to async — a DIFFERENT region
> of the file. Plan 054 rewrites `fetchBeadsStatus` in `project-detail.ts`.
> Both are compatible; re-verify excerpts against live code and proceed. Any
> OTHER structural drift → STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MEDIUM — unification changes visible counts on some UIs; each change is called out below so nothing shifts silently
- **Depends on**: plan 054 (project-detail must already read the cache)
- **Category**: correctness / tech-debt
- **Planned at**: commit `9c4c61ed`, 2026-07-19

## Why this matters

"Ready" currently has four definitions across the agent:

1. **bead-rollup** (`bead-rollup.ts:184-208`): not-closed ∧ not-blocked —
   includes `in_progress`. Documented as a deliberate "BEHAVIOR CHANGE vs
   the old `bd ready` CLI semantics".
2. **pulse** (`pulse.ts:110-145`): same not-blocked derivation, but scoped
   to standalone non-epic beads with status in {open, in_progress, blocked}.
3. **fleet-exceptions** (`fleet-exceptions.ts:167-171`): "ready" =
   `status === "open" && dependencyCount === 0` — a *different* rule that
   ignores blocked-status and treats ANY dependency (including
   non-blocking `relates-to`/`parent-child`) as disqualifying.
4. **project-detail**: pre-plan-054 it used live `bd ready` CLI semantics;
   after 054 it derives locally (a fifth near-copy).

The repo has a settled convention — pulse.ts calls it "this project's
existing 'ready is derived, not CLI-sourced' rule" — but no single function
embodies it, so each surface re-derives with drift. Meanwhile the LIVING
spec contradicts the code: `openspec/specs/bead-proposal-roadmap/spec.md:34-39`
SHALL-mandates intersection with `bd ready --json` membership, which
`bead-rollup.ts:186` explicitly no longer does ("No separate `bd ready`
call is issued") — an agent treating the spec as source of truth would
reintroduce the crash-loop spawn pattern.

Goal: one exported `deriveReadySet(beads)` in `bead-rollup.ts` (the semantic
home — pulse already imports `deriveBlockedIds` from there), every surface
consuming it with explicit per-surface *filters* (not re-derivations), and
the spec updated to describe the derived semantics.

## Current state — verified excerpts (at 9c4c61ed)

`bead-rollup.ts:184-208` (rollup's rule + the loop to extract):

```ts
 * `ready` is derived purely from `beads` (mirrors beads-watcher's
 * `deriveUnlinkedCounts`): a task bead is ready when it is not closed and not
 * blocked (per `deriveBlockedIds`). This is a BEHAVIOR CHANGE vs the old
 * `bd ready` CLI semantics ...
    if (b.status !== "closed" && !blockedIds.has(b.id)) ready++;
```

`fleet-exceptions.ts:163-171` (the divergent rule):

```ts
  // ready-head older than 30 days — "ready" = open + no blockers
  // (dependencyCount === 0). ...
  const readyStale = rows.filter((r) => {
    if (r.status !== "open" || r.dependencyCount !== 0) return false;
```

`openspec/specs/bead-proposal-roadmap/spec.md:34-39` (the stale mandate):

```
The rollup's `ready` count SHALL be the intersection of the proposal's task bead ids with
`bd ready --json` membership, and `blocked` SHALL count task beads whose status is `blocked` or
which have an unclosed `blocks` dependency, ...
```

## Steps

### Step 1 — Extract the canonical helper

In `bead-rollup.ts`, next to `deriveBlockedIds`, add:

```ts
/**
 * Canonical nx "ready" derivation ("ready is derived, not CLI-sourced" —
 * see routes/pulse.ts). A bead is ready when it is not closed and not
 * blocked per deriveBlockedIds. NOTE: includes `in_progress` (deliberate
 * divergence from `bd ready` CLI semantics, recorded in the
 * bead-proposal-roadmap spec). Surfaces layer FILTERS (non-epic,
 * standalone, open-statuses) on top — they must not re-derive readiness.
 */
export function deriveReadySet(beads: RawBead[]): Set<string> {
  const blockedIds = deriveBlockedIds(beads);
  const ready = new Set<string>();
  for (const b of beads) {
    if (b.status !== "closed" && !blockedIds.has(b.id)) ready.add(b.id);
  }
  return ready;
}
```

Rewrite `aggregateRollup`'s loop to use it (behavior-identical for rollup —
assert via existing tests). Verification: `bun test apps/agent/src/services/bead-rollup.test.ts` → 0 fail.

### Step 2 — Conform pulse (filter-only change)

`computeBeadsPulse` keeps its filters (non-epic, standalone,
OPEN_BEAD_STATUSES) but replaces its inline blocked/ready branch with
membership in `deriveReadySet(beads)`. Behavior-identical (its rule already
matches); existing pulse tests must pass unchanged.
Verification: `bun test apps/agent/src/routes/pulse.test.ts` → 0 fail.

### Step 3 — Conform fleet-exceptions (BEHAVIOR CHANGE — the point)

Replace the `dependencyCount === 0` rule in the `ready_head_stale` filter
with: `r.status === "open"` ∧ id ∈ `deriveReadySet(rows-as-beads)`.
Complication: `fleet-exceptions` rows come from `beads-reader.ts`'s
`BeadRow` projection, which may not carry `dependencies[]` needed by
`deriveBlockedIds` — read `beads-reader.ts`'s row shape first. If
`dependencies` is absent from `BeadRow`, extend the projection to carry the
minimal fields `deriveBlockedIds` needs (read its implementation for the
exact fields: dep type + depends_on status resolution) — this is in scope.
**Visible change**: beads with only non-blocking deps (relates-to,
parent-child) now count as ready-heads; blocked-status beads stop counting.
Update `fleet-exceptions.test.ts` fixtures accordingly and add one test per
newly-included / newly-excluded class.
Verification: `bun test apps/agent/src/lib/fleet-exceptions.test.ts` → 0 fail.

### Step 4 — Conform project-detail

Replace plan 054's local `blockedIds` filter with `deriveReadySet`
membership (mechanical; 054's note anticipates this).
Verification: `bun test apps/agent/src/routes/` → 0 fail.

### Step 5 — Fix the spec

Rewrite `openspec/specs/bead-proposal-roadmap/spec.md`'s "Ready and blocked
derivation match the fleet" requirement to state the ACTUAL contract: ready
= not-closed ∧ not-blocked derived in-process via `deriveReadySet`
(explicitly including `in_progress`, explicitly NO `bd ready` CLI call —
cite the crash-loop rationale nx-veo5g.1). Check `openspec/AGENTS.md` for
the correct procedure for amending a living spec (it may require an
openspec change proposal rather than direct edit — if so, author the
minimal proposal per that procedure instead of editing the spec in place,
and record that in your report).

## Done criteria (machine-checkable)

- `grep -c "export function deriveReadySet" apps/agent/src/services/bead-rollup.ts` → 1.
- `grep -rn "dependencyCount === 0" apps/agent/src/lib/fleet-exceptions.ts` → 0.
- `grep -c "deriveReadySet" apps/agent/src/routes/pulse.ts apps/agent/src/routes/project-detail.ts apps/agent/src/lib/fleet-exceptions.ts` → ≥ 1 each.
- `grep -c "bd ready --json\` membership" openspec/specs/bead-proposal-roadmap/spec.md` → 0.
- Full scoped suites green: `bun test apps/agent/src/services/bead-rollup.test.ts apps/agent/src/routes/pulse.test.ts apps/agent/src/lib/fleet-exceptions.test.ts apps/agent/src/routes/`.

## Out of scope — do not touch

- `beads-watcher.ts` `deriveUnlinkedCounts` (already mirrors the rollup rule
  per its docstring — verify, don't rewrite; if it has drifted, report).
- `resolveTasksMd` / any async-conversion region of `bead-rollup.ts` (owned
  by the in-flight `async-agent-hot-path-reads` proposal).
- Swift/web display logic (counts may shift on the fleet radar — that IS
  the fix; note it in the report).

## STOP conditions

- If `deriveBlockedIds` needs fields the fleet `BeadRow` cannot cheaply
  carry (e.g. it resolves depends-on STATUS transitively across the whole
  store), STOP and report the actual signature — a shallow adaptation that
  silently mis-derives is worse than the current divergence.
- If openspec procedure requires a proposal and that proposal would collide
  with `async-agent-hot-path-reads`' spec deltas, STOP and report.

## Maintenance notes

- Any future "ready" logic must be a filter over `deriveReadySet`, never a
  new derivation — the four-definitions drift is what this plan buys back.
- If bd's own ready semantics ever matter again (e.g. molecules/`bd ready
  --mol` adoption per plan 061), reconcile deliberately: the nx divergence
  (in_progress counts as ready) is now written into the spec.

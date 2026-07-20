# Plan 064: Pure-fs watcher fast-path; stop reporting abandoned proposals as "archived"

> **Executor instructions**: Follow this plan step by step, run every
> verification command, honor STOP conditions, and update this plan's row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 4bb98069..HEAD -- apps/agent/src/services/spec-watcher/ packages/core/src/types/spec-events.ts`
> On structural mismatch with the excerpts, STOP.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW (replaces a broken/corrupting path with the parser the poll loop already trusts; wire change is additive)
- **Depends on**: none (063 touches routes, this touches the watcher — disjoint). Do BEFORE plan 068.
- **Category**: correctness
- **Planned at**: commit `4bb98069`, 2026-07-19

## Why this matters

**Defect A — the 300ms fast-path is dead or corrupting.** The spec-watcher
has two refresh mechanisms: the 60s poll (pure-fs `pollProjectSpecs`,
reliable) and an `fs.watch`-triggered fast refresh
(`watcher.ts` `fetchSpecSnapshots`) that shells
`openspec show <spec> --json`. Two failure modes, both verified:

1. On homelab the CLI is absent (`poller.ts:11-21` documents it), so the
   spawn fails, `fetchSpecSnapshots` returns `null`, and the advertised
   "~300ms targeted refresh" (`index.ts` docs) never fires — edits wait up
   to 60s.
2. Where the CLI exists, `openspec show --json` emits a change/delta
   object that carries **no task counts**, and `normalizeShowOutput`
   (excerpt below) coerces the missing fields to `0` — resetting the
   in-memory completed/total and firing a spurious progress transition
   when the next full poll restores real numbers.

**Defect B — lifecycle conflation.** When a spec dir disappears from
`openspec/changes/`, the parser emits `{type:"removed"}`
(`parser.ts:170-171`), and `packages/core/src/types/spec-events.ts` maps
`removed` → wire `kind:"archived"`. But a dir disappears for two distinct
reasons: it was ARCHIVED (moved to `openspec/changes/archive/<date>-<slug>`)
or it was ABANDONED/deleted. The dashboard shows both as "archived".

## Current state — verified excerpts (at 4bb98069)

`watcher.ts:80-104` (the CLI spawn):

```ts
async function fetchSpecSnapshots(project, specName) {
  let stdout: string;
  try {
    stdout = await execText("openspec", ["show", specName, "--json"], {
      cwd: project.cwd, timeout: SUBPROCESS_TIMEOUT_MS,
    });
  } catch (err) { ... return null; }
```

`watcher.ts:105-122` (the zero-coercion):

```ts
    snapshots.push({
      name,
      status: typeof item.status === "string" ? item.status : "unknown",
      completedTasks: Number(item.completedTasks ?? item.completed_tasks ?? 0),
      totalTasks: Number(item.totalTasks ?? item.total_tasks ?? 0),
```

Pure-fs building block: `parseSpecFromPath` (`fs-snapshot.ts:74`) — the
exact parser the 60s poll uses (proposal/design/tasks presence + checkbox
counts → status). The watcher already knows the single spec dir path.

## Steps

### Step 1 — Replace the spawn with `parseSpecFromPath`

In `watcher.ts`, rewrite `fetchSpecSnapshots` to call `parseSpecFromPath`
on the single spec's directory (compose the path the same way the fs.watch
callback derives the spec name; read `refreshSingleSpec` and the watch
setup first for the exact join). Delete `normalizeShowOutput` and the
`execText` import if now unused. Preserve the existing return contract:
`SpecSnapshot[] | null` where `null`/empty triggers `handleEmptySnapshots`'s
full-rescan removal handling — verify by reading `handleEmptySnapshots`
(`watcher.ts:~125+`) and keep its semantics identical: a dir that no longer
exists must still flow into the removal path.

Verification: `bun test apps/agent/src/services/spec-watcher-fs-watch.test.ts apps/agent/src/services/spec-watcher/` → existing suite green.

### Step 2 — Regression test for the zero-reset

New test in the watcher suite (follow `spec-watcher-fs-watch.test.ts`
fixture patterns): a spec with 3/5 tasks complete gets a debounced refresh;
assert the emitted snapshot carries `completedTasks: 3, totalTasks: 5` (not
0/0), and no spurious transition fires when counts are unchanged. Second
test: refresh with PATH stripped of `openspec` still works (proves CLI-free).

### Step 3 — Split `removed` into archived vs abandoned

In the parser/emitter layer (`parser.ts:170` region): when a spec
disappears, check whether `openspec/changes/archive/` now contains a dir
matching `*-<slug>` (the archive naming convention —
`session-spec-link.ts`'s resolver uses the same pattern; reuse or mirror
it). Emit `removed` with a new `reason: "archived" | "abandoned"` field.
In `spec-events.ts:47-48`, map to wire `kind:"archived"` (unchanged) vs a
NEW wire kind `"abandoned"`.

**Client-safety gate**: before adding the new kind, check how Swift decodes
spec-event kinds — grep `apps/swift/NexusShared` for the spec-events decode
(`SpecSummary.swift` / spec-events model). If the enum decode is exhaustive
(unknown kind → decode FAILURE), either (a) add the case to Swift in the
same change (allowed — additive), or (b) keep the wire kind `archived` and
put `reason` in a new optional field instead. Choose whichever keeps old
clients decoding; document the choice.

Verification: watcher suite + a new archived-vs-abandoned test (create
fixture dirs, move one to archive/, delete the other, assert reasons).

### Step 4 — Sweep

```
bun test apps/agent/src/services/
pnpm --filter @nexus/agent typecheck
```

## Done criteria (machine-checkable)

- `grep -c "execText(\"openspec\"" apps/agent/src/services/spec-watcher/watcher.ts` → 0.
- `grep -c "normalizeShowOutput" apps/agent/src/services/spec-watcher/` → 0.
- Zero-reset regression test present and green; CLI-free test green.
- Archived-vs-abandoned distinction present with the client-safety choice
  from Step 3 documented in the report.

## Out of scope — do not touch

- The 60s poll loop, batching, `SpecTransition` bus mechanics.
- routes/specs.ts (plan 063).
- Swift rendering beyond the minimal additive decode case (if option (a)).

## STOP conditions

- If `parseSpecFromPath`'s status derivation differs from what the watcher
  previously got from `openspec show` in a way that changes transition
  semantics (compare both against the poll path's output for the same
  fixture), STOP and report the delta — poll and fast-path must agree.
- Step 3's client-safety gate as written.

## Maintenance notes

- After 063 + this plan, `grep -rn "execText(\"openspec\"" apps/agent/src`
  should return ZERO — the daemon is openspec-CLI-free. Any reintroduction
  is a review flag (homelab does not have the binary).
- If plan 066 later installs the CLI on homelab for validation, that does
  NOT license request-path/watch-path spawns — validation is a CI/gate
  concern, not a serving concern.

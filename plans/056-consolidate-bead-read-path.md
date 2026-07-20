# Plan 056: Consolidate the bead read path — one parser, completeness gate, retire dead Dolt code, shape-drift guards

> **Executor instructions**: Follow this plan step by step, run every
> verification command, honor STOP conditions, and update this plan's row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 9c4c61ed..HEAD -- apps/agent/src/lib/beads-reader.ts apps/agent/src/services/beads-watcher.ts apps/agent/src/lib/fleet-exceptions.ts apps/agent/src/services/cached-bead-source.ts`
> On any in-scope structural change, re-verify excerpts; on mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M–L
- **Risk**: MEDIUM — touches both the fleet feed and the dashboard cache feed; mitigated by strong existing suites and a fixture-parity test added first
- **Depends on**: none (independent of 054/055; touches different functions than the `async-agent-hot-path-reads` openspec proposal)
- **Category**: correctness / tech-debt
- **Planned at**: commit `9c4c61ed`, 2026-07-19

## Why this matters — and the settled architecture decision to honor

The beads docs (v1.1.0, sync-concepts) are explicit that `issues.jsonl` is a
passive export, not the database. The maximalist response — shell to `bd
--json` for all reads — was **considered and REJECTED** for this repo: the
nx-6lrf7/nx-veo5g crash loop was caused by exactly that pattern (piled-up
`bd`/`dolt` processes), and the zero-spawn JSONL watcher + cache
(`cached-bead-source.ts`, nx-veo5g.1) is the deliberate remediation. Since
bd's auto-flush rewrites the full JSONL (deletes/prunes DO disappear on the
next flush), steady-state JSONL reading is sound. Do not "upgrade" it to
CLI polling.

What remains genuinely wrong with the current read path:

1. **Two independent JSONL parsers with opposite failure contracts.**
   `beads-watcher.ts:parseIssuesJsonl` (lines ~100-122): ANY malformed line
   → whole read returns `null` → caller keeps previous cache (safe against
   mid-flush truncation). `beads-reader.ts:toRowFromJsonl`/`readViaJsonl`
   (lines ~242-306): skips bad lines and accepts whatever parsed — so a
   truncated flush whose surviving lines all parse yields a **silent
   undercount** on the fleet `/exceptions` feed (5s flush debounce per
   `.beads/config.yaml` makes this window real). Also two field
   projections to maintain against export-shape changes.
2. **~150 lines of dead code**: `beads-reader.ts`'s Dolt-SQL fast path
   requires a `dolt-server.port` file that never exists in embedded mode —
   the file header itself admits "every nx store in practice resolves
   through the JSONL fallback" (lines 20-24), and `mysql2` is deliberately
   not a dependency.
3. **No guard on the export-shape coupling**: `reconstructParent`
   (`beads-watcher.ts:77-85`) rebuilds `parent` from the `parent-child`
   dependency edge because `bd export` omits the flattened `parent` that
   `bd list --json` includes. If a bd upgrade changes edge emission, every
   roadmap capability silently shows zero proposals (all consumers
   null/[]-degrade). Nothing would alarm.
4. **No mtime short-circuit in the fleet walk**: `fleet-exceptions`
   re-reads every repo's full multi-MB JSONL each 5-min refresh even when
   unchanged.

## Current state — key excerpts (at 9c4c61ed)

`beads-watcher.ts:100-118` (strict parser — the surviving semantics):

```ts
export function parseIssuesJsonl(content: string): RawBead[] | null {
  const beads: RawBead[] = [];
  for (const rawLine of content.split("\n")) {
    ...
    try {
      obj = JSON.parse(line);
    } catch {
      return null; // fail-open: any bad line invalidates this read
    }
```

`beads-reader.ts:242-250` (tolerant parser — to be retired):

```ts
function toRowFromJsonl(r: RawJsonlIssue): BeadRow | null {
  if (!r.id) return null;
  return {
    id: r.id,
    title: r.title ?? "",
```

Watcher flow: `fs/promises` `watch` on `.beads/`, 300ms debounce,
unconditional 60s poll, cache in `parsedBeadsCache` keyed by project path
(`beads-watcher.ts:33,49,173,210-227,308+`). Fleet flow:
`fleet-exceptions.ts` → `readBeadsStore` (beads-reader) per repo per 5-min
SWR refresh.

## Steps

### Step 1 — Shape-drift guard FIRST (protects everything after)

Add `apps/agent/src/services/beads-export-shape.test.ts`:

1. A checked-in fixture `apps/agent/src/services/__fixtures__/issues-export-sample.jsonl`
   containing ~10 REAL-shaped lines copied from the repo's own
   `.beads/issues.jsonl` (pick beads with: a parent-child dep, a blocks
   dep, labels, a closed one, a deferred one — scrub nothing, they're not
   secret, but keep it small).
2. Tests: `parseIssuesJsonl(fixture)` reconstructs `parent` on the
   parent-child bead; all 10 parse; a fixture copy with one truncated line
   returns `null`.
3. A canary comment in the fixture header: "Regenerate from a real `bd
   export` line set after any bd upgrade; if reconstructParent tests fail
   after regeneration, the export shape drifted — see plan 056."

Verification: `bun test apps/agent/src/services/beads-export-shape.test.ts` → green.

### Step 2 — Single shared parser module

Create `apps/agent/src/lib/beads-jsonl.ts` exporting:

- `parseIssuesJsonl(content): RawBead[] | null` — MOVED verbatim from
  `beads-watcher.ts` (strict contract wins), including `reconstructParent`.
- `toBeadRows(beads: RawBead[]): BeadRow[]` — the beads-reader projection
  (id/title/status/priority/issueType/createdAt/updatedAt/dependencyCount/
  labels — read `beads-reader.ts`'s full `BeadRow` type first and preserve
  every field it carries, plus whatever plan 055 added for
  `deriveBlockedIds`).

`beads-watcher.ts` re-exports/imports from the new module (its public API
`parseIssuesJsonl` export must keep working for existing test imports —
keep a re-export). `beads-reader.ts`'s `readViaJsonl` becomes: read file →
shared `parseIssuesJsonl` (strict) → `toBeadRows`. **Contract change**: a
malformed fleet store now yields `null` (skip that repo this refresh,
keeping SWR's previous value) instead of a silent partial — verify how
`fleet-exceptions` handles a `null` store read (read the call site;
preserve its degrade behavior).

Verification:

```
bun test apps/agent/src/services/beads-watcher.test.ts
bun test apps/agent/src/lib/fleet-exceptions.test.ts
bun test apps/agent/src/services/beads-export-shape.test.ts
```

### Step 3 — Retire the dead Dolt path

In `beads-reader.ts`, delete the Dolt-SQL discovery + `readViaDolt` +
`loadMysql` machinery (the file header at lines 20-26 identifies it).
Preserve the MIT attribution comment block if it pertains to remaining
code; if the attribution covers only the deleted portion, keep a one-line
provenance note. `readBeadsStore` becomes JSONL-only. Grep for any test
exercising the Dolt path and delete/adjust those tests with a note.

Verification: `bun test apps/agent/src/lib/` → 0 fail;
`grep -c "mysql\|dolt-server.port" apps/agent/src/lib/beads-reader.ts` → 0.

### Step 4 — mtime short-circuit for the fleet walk

In `beads-reader.ts` (or the new module): before reading a store, `stat`
the JSONL; keep a module-level `Map<path, {mtimeMs, size, rows}>`; on
match, return cached rows. Export a `resetBeadsReaderCacheForTests()`.
Add a test: second read with unchanged mtime does not re-read (spy on
readFile), changed mtime does.

Verification: `bun test apps/agent/src/lib/` → 0 fail.

### Step 5 — Full sweep

```
bun test apps/agent/src
pnpm --filter @nexus/agent typecheck
```

Expected: no new failures vs a baseline run recorded before Step 1; only
pre-existing baseline typecheck errors.

## Done criteria (machine-checkable)

- Exactly ONE `parseIssuesJsonl` implementation:
  `grep -rln "return null; // fail-open" apps/agent/src` → 1 file (the shared module).
- `grep -c "toRowFromJsonl" apps/agent/src/lib/beads-reader.ts` → 0.
- Dead Dolt path gone (Step 3 grep → 0).
- Fixture-based shape test present and green; truncation test proves
  strict-fail on the fleet path.
- mtime cache test proves no redundant re-read.

## Out of scope — do not touch

- `cached-bead-source.ts` cold-start `bd list` (correct as designed).
- Watcher debounce/poll cadence and `project_status_snapshots` writes.
- `bead-rollup.ts` (owned by plan 055 + the async openspec proposal).
- Any move toward CLI-polling reads (explicitly rejected — see Why).

## STOP conditions

- If `BeadRow` and `RawBead` field sets conflict in a way that changes
  fleet-exceptions' observable output beyond the documented strict-fail
  change (e.g. labels parsed differently), STOP and report the field diff.
- If any consumer outside the agent imports `beads-reader`'s Dolt exports
  (grep repo-wide first), STOP and report.
- If the real `.beads/issues.jsonl` contains `_type` values other than
  `issue`/`memory` or a `_schema` header line that the strict parser would
  fail on (CHECK: `grep -c '"_type"' .beads/issues.jsonl` and inspect the
  first line), adapt the shared parser to tolerate non-issue `_type` lines
  by SKIPPING them (documented in the module) — that is in scope; anything
  weirder, STOP and report.

## Maintenance notes

- After any `bd` upgrade, regenerate the Step-1 fixture from a fresh export
  and re-run the shape suite — that is now the drift alarm for the
  `reconstructParent` coupling.
- If bd ever adds `parent` to the export shape, `reconstructParent` becomes
  a no-op (it never overwrites a present parent) — safe, but the fixture
  should then be regenerated to cover the flattened field.

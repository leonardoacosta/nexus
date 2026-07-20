# Plan 054: Route `/project/:code` bead status onto the cached source; fix the open/ready mislabel

> **Executor instructions**: Follow this plan step by step, run every
> verification command, honor STOP conditions, and update this plan's row in
> `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 9c4c61ed..HEAD -- apps/agent/src/routes/project-detail.ts apps/agent/src/services/cached-bead-source.ts apps/agent/src/routes/project-status.ts`
> On any in-scope change, re-verify the excerpts below; on mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (moves two routes onto the same cache every sibling route already uses; degrade contract unchanged)
- **Depends on**: none (do BEFORE plan 055, which builds on the shared derivation this plan starts consuming)
- **Category**: performance + correctness
- **Planned at**: commit `9c4c61ed`, 2026-07-19

## Why this matters

The nx-veo5g/nx-6lrf7 crash loop was caused by request-path `bd`/`dolt`
subprocess storms. The remediation (nx-veo5g.1, "Layer A") introduced
`cached-bead-source.ts`: every bead-serving route reads the beads-watcher's
in-memory JSONL cache, with at most ONE single-flighted `bd list --all
--json` per cold project. `/specs`, `/specs/all`, `/roadmap`,
`/beads/unlinked`, and `/pulse` were all migrated.

Two routes were missed: `GET /project/:code/status` and `GET
/project/:code/beads` (both dispatch into `fetchBeadsStatus` in
`routes/project-detail.ts`), which still spawn a live `bd ready --json` on
**every request** — the exact pattern the remediation exists to remove, on a
mac-Detail-view polling path.

Secondary bug in the same function: it returns `open_count: items.length,
ready_count: items.length` — "open" is silently defined as "ready" (blocked
and in_progress work is invisible in the open count).

## Current state

### Excerpt — `apps/agent/src/routes/project-detail.ts:257-277` (at 9c4c61ed)

```ts
async function fetchBeadsStatus(cwd: string): Promise<BeadsStatus> {
  const defaultBeads: BeadsStatus = { open_count: 0, ready_count: 0, items: [] };

  if (!existsSync(join(cwd, ".beads"))) return defaultBeads;

  const result = await spawnWithTimeout(["bd", "ready", "--json"], cwd);
  if (!result.ok) return defaultBeads;

  try {
    const items = JSON.parse(result.stdout);
    if (!Array.isArray(items)) return defaultBeads;

    return {
      open_count: items.length,
      ready_count: items.length,
      items,
    };
  } catch {
    return defaultBeads;
  }
}
```

### Exemplar — the cache-first source everyone else uses (`cached-bead-source.ts:50-56`)

```ts
export async function getBeadsForProject(cwd: string): Promise<RawBead[]> {
  const cached = getParsedBeads(cwd);
  if (cached !== undefined) return cached;
  // ...cold start: exactly ONE `bd list --all --json`, single-flighted; [] on failure
```

### Semantics to match — the repo's settled "derived, not CLI-sourced" rule

`routes/pulse.ts:119-123` documents the convention: "`ready`/`blocked` are
derived purely from the fetched bead set via `deriveBlockedIds`
(bead-rollup.ts's own convention) — no separate `bd ready`/`bd blocked` CLI
call, consistent with this project's existing 'ready is derived, not
CLI-sourced' rule." `bead-rollup.ts` exports `deriveBlockedIds(beads)`.

## Steps

### Step 1 — Rewrite `fetchBeadsStatus` onto the cache

In `routes/project-detail.ts`:

```ts
import { getBeadsForProject } from "../services/cached-bead-source";
import { deriveBlockedIds } from "../services/bead-rollup";

const OPEN_STATUSES = new Set(["open", "in_progress", "blocked"]);

async function fetchBeadsStatus(cwd: string): Promise<BeadsStatus> {
  const defaultBeads: BeadsStatus = { open_count: 0, ready_count: 0, items: [] };
  if (!existsSync(join(cwd, ".beads"))) return defaultBeads;

  const beads = await getBeadsForProject(cwd);
  if (beads.length === 0) return defaultBeads;

  const blockedIds = deriveBlockedIds(beads);
  const openBeads = beads.filter(
    (b) => b.status !== undefined && OPEN_STATUSES.has(b.status),
  );
  const readyBeads = openBeads.filter((b) => !blockedIds.has(b.id));
  return {
    open_count: openBeads.length,
    ready_count: readyBeads.length,
    items: readyBeads,
  };
}
```

Notes: keep the `BeadsStatus` wire shape identical (`open_count`,
`ready_count`, `items`); `items` stays the ready set (that is what it held
before — the `bd ready` output). Read the actual `RawBead` field names in
`bead-rollup.ts` before writing the filter (status/issue_type casing).
Remove the now-unused `spawnWithTimeout` import IF this was its only use in
the file (grep first — other functions in project-detail may use it; if so,
leave the import).

### Step 2 — Tests

`routes/project-status.test.ts` and/or a `project-detail` test file exist —
find the current coverage of `fetchBeadsStatus`/these routes (grep
`fetchBeadsStatus\|/project/` in `apps/agent/src/routes/*.test.ts`) and
follow its mock pattern:

1. warm cache: no subprocess spawn occurs (spy on `execJson`/spawn seam);
   counts derive from the parsed set;
2. open vs ready now differ: a fixture with one open-unblocked, one
   open-blocked (via a `blocks` dependency), one in_progress-unblocked, one
   closed → `open_count === 3`, `ready_count === 2`;
3. no `.beads` dir → default zeros (unchanged);
4. cold cache + live-call failure → default zeros (degrade contract).

Verification:

```
bun test apps/agent/src/routes/ 
bun test apps/agent/src/services/cached-bead-source.test.ts
pnpm --filter @nexus/agent typecheck
```

Expected: 0 new failures; only pre-existing baseline typecheck errors, none
in touched files.

## Done criteria (machine-checkable)

- `grep -c "bd\", \"ready\|\"bd ready\|spawnWithTimeout(\[\"bd\"" apps/agent/src/routes/project-detail.ts` → 0.
- `grep -c "getBeadsForProject" apps/agent/src/routes/project-detail.ts` → ≥ 1.
- New test proving `open_count !== ready_count` on the mixed fixture: present and green.
- `bun test apps/agent/src/routes/` → 0 failures.

## Out of scope — do not touch

- `cached-bead-source.ts`, `beads-watcher.ts` (plan 056's territory).
- The other three "ready" definitions (plan 055 unifies semantics; this plan
  just conforms these two routes to the derived convention).
- `server-request-handler.ts` (the in-flight openspec proposal
  `mechanize-route-registry-parity` owns that file — do not create a
  conflict).
- Swift/web clients (wire shape unchanged).

## STOP conditions

- If the `items` array's consumers (grep the Swift Detail view /
  `agent-radar-client.ts` for `ready_count`/`items` usage) turn out to
  depend on `bd ready`'s exact item shape (fields beyond the JSONL-parsed
  `RawBead`), STOP and report the field diff — the cache's `RawBead` shape
  and `bd ready --json` output may differ.
- If `deriveBlockedIds` is not exported from `bead-rollup.ts` at HEAD, STOP
  (plan 055 or the openspec proposal may have moved it) and report its new
  location.

## Maintenance notes

- This makes `cached-bead-source` the ONLY production bead read for all
  routes; any new bead-serving route must import it — a raw `bd` spawn in a
  route file is a review smell (the crash-loop lesson).
- Plan 055 will fold this function's open/ready derivation into a shared
  helper; keep the logic minimal here so 055's extraction is mechanical.

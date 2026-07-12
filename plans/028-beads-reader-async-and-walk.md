# Plan 028: Convert beads-reader sync reads to fs/promises + yield between fleet stores; surface the depth-1 walk gap (operator-gated)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index. When you mark the row DONE/BLOCKED/REJECTED you MUST
> append `spec-impact: <slug>[, ...]` or `spec-impact: none` to the row.
>
> **Drift check (run first)**:
> `git diff --stat b7096486..HEAD -- apps/agent/src/lib/beads-reader.ts apps/agent/src/lib/fleet-exceptions.ts apps/agent/src/lib/fleet-exceptions.test.ts`
> At plan-writing time (2026-07-11, HEAD `d458ef8e`) this diff was EMPTY — the
> only commit past `b7096486` was a beads-JSONL sync. If the diff is non-empty
> when you run it, compare the "Current state" excerpts below against the live
> code before proceeding; on a mismatch, treat it as a STOP condition.
> Note: Leo works directly in `~/dev/personal/nexus`, and at plan-writing time
> a concurrent session had uncommitted edits to
> `apps/agent/src/services/credential-usage-poller{,.test}.ts` — those files
> are unrelated and out of scope; ignore them. Execute this plan in a worktree.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none (plan 023 is referenced only for the CI-baseline caveat; plan 031 owns the statusline and shares no files with this plan)
- **Category**: perf
- **Planned at**: commit `b7096486`, 2026-07-11

## Why this matters

`readViaJsonl` (`apps/agent/src/lib/beads-reader.ts:270`) does a blocking
`readFileSync` of `.beads/issues.jsonl`, and it runs inside the long-lived
single-threaded Bun daemon's event loop. It is called (via `readBeadsStore`)
sequentially per repo by `computeFleetExceptions`
(`apps/agent/src/lib/fleet-exceptions.ts:240-262`), which is the `compute()`
of the stale-while-revalidate exceptions cache
(`apps/agent/src/routes/exceptions.ts` — TTL 5 min, detached background
refresh triggered by stale `GET /exceptions` reads, wired into the daemon's
request handler at `server-request-handler.ts:721`). Every sync read blocks
socket hook ingest, WebSocket frames, and every other in-flight route.

Fresh stat (2026-07-11): the default depth-1 walk of `~/dev` reads three
stores — `brown` (2.88 MB), `cc` (2.95 MB), `central-planning` (13.6 MB),
~19.5 MB total per refresh cycle. The 13.6 MB read + line-by-line
`JSON.parse` of `central-planning` is the dominant single stall. The fix is a
mechanical `fs/promises` conversion — `readBeadsStore` is already `async`, so
the daemon-side call chain needs zero signature changes above the reader —
plus an event-loop yield between repos so the residual sync `JSON.parse`
chunks cannot coalesce into one long block. This exactly mirrors shipped plan
019 (`plans/019-async-credential-pool-reader.md`, credential-pool
`reader.ts` → `fs/promises`, DONE).

This plan also surfaces (but does NOT execute) a separate finding: the fleet
walk is depth-1 only and silently misses most of the fleet, including nx
itself. Widening it changes feed content and read volume, so it is an
explicit operator decision — see "Gated option" below.

## Current state

All source work is in three files:

- `apps/agent/src/lib/beads-reader.ts` — whole-graph read of one `.beads/`
  store; Dolt primary, JSONL fallback; contract: never throws, `null` =
  unreadable, `[]` = clean-empty. Contains all three `readFileSync` sites.
- `apps/agent/src/lib/fleet-exceptions.ts` — walks `~/dev/*`, calls
  `readBeadsStore` per repo, classifies into exception entries.
- `apps/agent/src/lib/fleet-exceptions.test.ts` — the combined suite for both
  modules (18 tests, all currently pass); calls `readViaJsonl` and
  `discoverDolt` synchronously in 6 places.

**Sync import** (`beads-reader.ts:33`):

```ts
import { existsSync, readFileSync } from "node:fs";
```

**Sync read site 1 — discoverDolt metadata.json** (`beads-reader.ts:88-93`):

```ts
    let meta: BeadsMetadata;
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf8")) as BeadsMetadata;
    } catch {
      return null;
    }
```

**Sync read site 2 — discoverDolt port sidecar** (`beads-reader.ts:100-105`):

```ts
    const portFile = join(beadsDir, "dolt-server.port");
    if (existsSync(portFile)) {
      const raw = readFileSync(portFile, "utf8").trim();
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) port = parsed;
    }
```

`discoverDolt` is currently synchronous (`beads-reader.ts:83`):

```ts
export function discoverDolt(beadsDir: string): DoltDiscovery | null {
```

**Sync read site 3 — readViaJsonl** (`beads-reader.ts:264-273`):

```ts
export function readViaJsonl(beadsDir: string): BeadRow[] | null {
  const jsonlPath = join(beadsDir, "issues.jsonl");
  if (!existsSync(jsonlPath)) return null;

  let content: string;
  try {
    content = readFileSync(jsonlPath, "utf8");
  } catch {
    return null;
  }
```

**Orchestrator call sites** (`beads-reader.ts:314-332`):

```ts
export async function readBeadsStore(
  beadsDir: string,
): Promise<BeadRow[] | null> {
  try {
    if (!existsSync(beadsDir)) return null;

    const discovery = discoverDolt(beadsDir);
    if (discovery) {
      const doltRows = await readViaDolt(discovery);
      if (doltRows !== null) return doltRows;
      // Dolt discoverable but read failed — fall through to JSONL.
    }

    return readViaJsonl(beadsDir);
  } catch (err) {
    log.warn({ err, beadsDir }, "readBeadsStore failed; returning null");
    return null;
  }
}
```

**Fleet walk + sequential read loop** (`fleet-exceptions.ts:232-262`, excerpt):

```ts
  let repos: string[];
  try {
    repos = readdirSync(devRoot);
  } catch (err) {
    log.warn({ err, devRoot }, "cannot read fleet root; empty result");
    return { exceptions, skipped };
  }

  for (const repo of repos) {
    if (repo.startsWith(".")) continue;
    const repoPath = join(devRoot, repo);
    const beadsDir = join(repoPath, ".beads");

    // Only repos that HAVE a .beads store participate at all.
    let hasBeads: boolean;
    try {
      hasBeads = statSync(repoPath).isDirectory() && existsSync(beadsDir);
    } catch {
      continue;
    }
    if (!hasBeads) continue;

    let rows: BeadRow[] | null;
    try {
      rows = await readStore(beadsDir);
    } catch (err) {
```

**Test call sites to update** (`fleet-exceptions.test.ts`) — six sites,
currently synchronous:

| Line | Call |
|------|------|
| 111 | `const rows = readViaJsonl(beadsDir);` |
| 122 | `expect(readViaJsonl(beadsDir)).toBeNull();` |
| 129 | `expect(readViaJsonl(beadsDir)).toBeNull();` |
| 137 | `expect(readViaJsonl(beadsDir)).toEqual([]);` |
| 148 | `expect(discoverDolt(beadsDir)).toBeNull();` |
| 160 | `expect(discoverDolt(beadsDir)).toEqual({ database: "nx", port: 3307 });` |

**Repo conventions that apply here**:

- This is a pnpm + Bun monorepo (NOT standard T3 — no tRPC). The agent is
  Bun-only; `Bun.*` globals are used in agent source (e.g.
  `apps/agent/src/server.ts:128` uses `Bun.sleepSync`).
- The async-fs convention is `import { readFile } from "node:fs/promises"` —
  16+ agent files already do this; the exemplar for THIS exact conversion is
  `apps/agent/src/services/credential-pool/reader.ts:93` (shipped plan 019).
- Tests are `bun:test`, colocated `<module>.test.ts`. The suite for both
  in-scope modules is the single file `fleet-exceptions.test.ts`.
- `readBeadsStore` contract (docstring, `beads-reader.ts:27-30`): NEVER
  throws; `null` = unreadable, `[]` = clean-empty. Preserve it exactly.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0 (see CI-baseline caveat below) |
| Lint | `pnpm lint` | exit 0 |
| This plan's suite | `cd apps/agent && bun test src/lib/fleet-exceptions.test.ts` | `18 pass / 0 fail` (baseline verified 2026-07-11) |
| SQL-safety gate | `scripts/lint-sql-safety.sh` | KNOWN RED at HEAD (false positive; plan 023 fixes it — NOT your concern) |

**CI-baseline caveat**: CI (`.github/workflows/ci.yml`) is red on main since
2026-07-10 solely due to the `lint-sql-safety` false positive (plan 023 owns
the fix). Until 023 lands, the criterion for this plan is: **no new
typecheck/lint/test failures attributable to the three changed files**. Note:
the full agent suite (`bun test` with no filter) needs `NEXUS_ATTACH_SECRET=test`
in the environment; the fleet-exceptions suite alone does not.

## Scope

**In scope** (the only files you may modify):

- `apps/agent/src/lib/beads-reader.ts`
- `apps/agent/src/lib/fleet-exceptions.ts`
- `apps/agent/src/lib/fleet-exceptions.test.ts`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):

- `apps/agent/src/routes/exceptions.ts` — the SWR cache is correct as-is
  (settled: the isolation shape is right; only the refresh work was
  synchronous).
- `apps/agent/src/server-request-handler.ts` — wiring unchanged.
- The remaining `existsSync`/`statSync`/`readdirSync` calls in both source
  files — sub-millisecond metadata stats, not the multi-MB reads this finding
  is about. Converting them is scope creep; leave them.
- `apps/nexus-statusline/**` — plan 031's territory.
- `scripts/lint-sql-safety.sh` — plan 023's territory.
- Widening the fleet walk past depth 1 — operator-gated, see below. Do NOT
  implement it in this plan's execution.
- `apps/agent/src/services/credential-usage-poller{,.test}.ts` — concurrent
  session's uncommitted work; never stage or revert these.

## Git workflow

- Branch: `advisor/028-beads-reader-async` (matches prior advisor branches,
  e.g. `advisor/019-...` per `plans/README.md`).
- One commit, conventional style, e.g.:
  `perf(agent): convert beads-reader to fs/promises, yield between fleet stores`
- Commit message via a file (`git commit -F <file>`), never a HEREDOC chained
  with `&&`.
- Stage ONLY the three in-scope source/test files (targeted `git add <paths>`;
  never `git add .` — the shared tree has unrelated uncommitted edits).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Run the drift check

Run the drift-check command from the header. Expected: empty diff for the
three in-scope paths. If non-empty, diff the excerpts above against live code;
on mismatch, STOP.

**Verify**: `git diff --stat b7096486..HEAD -- apps/agent/src/lib/beads-reader.ts apps/agent/src/lib/fleet-exceptions.ts apps/agent/src/lib/fleet-exceptions.test.ts` → no output (or output matching the excerpts above on inspection).

Also confirm nothing outside this plan imports the two functions whose
signatures change:

**Verify**: `grep -rln "readViaJsonl\|discoverDolt" apps/ packages/ --include="*.ts"` → exactly two files: `apps/agent/src/lib/beads-reader.ts` and `apps/agent/src/lib/fleet-exceptions.test.ts`. Any additional file → STOP (a new importer appeared since planning).

### Step 2: Convert the imports in beads-reader.ts

Replace line 33:

```ts
import { existsSync, readFileSync } from "node:fs";
```

with:

```ts
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
```

**Verify**: `grep -n "readFileSync\|node:fs" apps/agent/src/lib/beads-reader.ts` → shows the two new import lines and NO `readFileSync` anywhere (the three call sites still reference it until Steps 3-4 — run this verify again after Step 4; at this point expect exactly 3 remaining `readFileSync` call-site hits and zero import of it).

### Step 3: Make discoverDolt async (2 read sites)

In `beads-reader.ts`:

1. Change the signature (line 83) from
   `export function discoverDolt(beadsDir: string): DoltDiscovery | null {`
   to
   `export async function discoverDolt(beadsDir: string): Promise<DoltDiscovery | null> {`
2. Site 1 (line ~90): `meta = JSON.parse(readFileSync(metaPath, "utf8")) as BeadsMetadata;`
   → `meta = JSON.parse(await readFile(metaPath, "utf8")) as BeadsMetadata;`
   (the surrounding inner `try/catch { return null; }` stays exactly as-is —
   an `await` rejection is caught the same way a sync throw was).
3. Site 2 (line ~102): `const raw = readFileSync(portFile, "utf8").trim();`
   → `const raw = (await readFile(portFile, "utf8")).trim();`
   (a rejection here — e.g. the sidecar vanishing between `existsSync` and the
   read — is caught by the function-wide outer `try/catch` at lines 84/112,
   returning `null`; behavior unchanged).

Do not change the docstring's contract ("Never throws" still holds — the
returned promise never rejects).

**Verify**: `grep -n "async function discoverDolt" apps/agent/src/lib/beads-reader.ts` → one hit.

### Step 4: Make readViaJsonl async; await both in readBeadsStore

In `beads-reader.ts`:

1. Change the signature (line 264) from
   `export function readViaJsonl(beadsDir: string): BeadRow[] | null {`
   to
   `export async function readViaJsonl(beadsDir: string): Promise<BeadRow[] | null> {`
2. Line ~270: `content = readFileSync(jsonlPath, "utf8");`
   → `content = await readFile(jsonlPath, "utf8");`
   (surrounding `try/catch { return null; }` unchanged).
3. In `readBeadsStore`, line ~320:
   `const discovery = discoverDolt(beadsDir);`
   → `const discovery = await discoverDolt(beadsDir);`
4. In `readBeadsStore`, line ~327:
   `return readViaJsonl(beadsDir);`
   → `return await readViaJsonl(beadsDir);`
   The `await` here is load-bearing: a plain `return` of the promise would
   let a rejection escape the enclosing `try/catch`, breaking the never-throws
   contract. Keep `return await`.

**Verify**: `grep -n "readFileSync" apps/agent/src/lib/beads-reader.ts` → no output, exit 1.
**Verify**: `cd apps/agent && bunx tsc --noEmit 2>&1 | grep -c "beads-reader"` → `0` (or run `pnpm typecheck` from the repo root: exit 0). Type errors in `fleet-exceptions.test.ts` are EXPECTED at this point (fixed in Step 5); errors in `beads-reader.ts` itself are not.

### Step 5: Update the six test call sites

In `apps/agent/src/lib/fleet-exceptions.test.ts`, make the six `it` callbacks
that call `readViaJsonl`/`discoverDolt` `async` and `await` the calls:

- Line 98: `it("readViaJsonl parses valid lines and skips malformed ones", () => {` → `... async () => {`; line 111 → `const rows = await readViaJsonl(beadsDir);`
- Line 117 block: `async () => { ... expect(await readViaJsonl(beadsDir)).toBeNull(); }` (line 122)
- Line 125 block: same pattern (line 129)
- Line 132 block: `expect(await readViaJsonl(beadsDir)).toEqual([]);` (line 137)
- Line 140 block: `expect(await discoverDolt(beadsDir)).toBeNull();` (line 148)
- Line 151 block: `expect(await discoverDolt(beadsDir)).toEqual({ database: "nx", port: 3307 });` (line 160)

Touch nothing else in the file — the `classifyRepo` and
`computeFleetExceptions` describes already use async callbacks or pure calls
and are unaffected. Note the `computeFleetExceptions` fixture tests
(lines 252-309) use the DEFAULT `readStore` against real tmp-dir stores, so
they exercise the converted async read path end-to-end for free — no new
tests are required for the conversion itself.

**Verify**: `cd apps/agent && bun test src/lib/fleet-exceptions.test.ts` → `18 pass / 0 fail`.

### Step 6: Add the per-store event-loop yield in computeFleetExceptions

In `apps/agent/src/lib/fleet-exceptions.ts`, inside the `for (const repo of
repos)` loop, immediately after `if (!hasBeads) continue;` (line 252) and
before the `let rows: BeadRow[] | null;` declaration, insert:

```ts
    // Yield the event loop between stores so consecutive multi-MB JSONL
    // parses (the sync JSON.parse chunks inside readViaJsonl) cannot
    // coalesce into one long block (plan 028). One yield per store that
    // actually participates — dirs without .beads skip it.
    await Bun.sleep(0);
```

`Bun.sleep` is the repo's convention for async waits (the agent is Bun-only;
cf. `Bun.sleepSync` in `apps/agent/src/server.ts:128` and `Bun.sleep` across
agent tests). Do not add an import — `Bun` is a global under the agent's
types.

**Verify**: `cd apps/agent && bun test src/lib/fleet-exceptions.test.ts` → `18 pass / 0 fail` (the fixture tests drive the loop through the yield).
**Verify**: `grep -n "Bun.sleep(0)" apps/agent/src/lib/fleet-exceptions.ts` → one hit inside `computeFleetExceptions`.

### Step 7: Full-gate pass and commit

Run the repo gates and commit the three files.

**Verify**: `pnpm typecheck` → exit 0.
**Verify**: `pnpm lint` → exit 0.
**Verify**: `cd apps/agent && bun test src/lib/fleet-exceptions.test.ts` → `18 pass / 0 fail`.
**Verify**: `git status --porcelain` after staging → only the three in-scope files staged (plus `plans/README.md` if you maintain the row); `.beads/`, credential-usage-poller files, and everything else untouched.

If `pnpm typecheck`/`pnpm lint` fail, attribute: failures in files this plan
did not touch are the pre-existing baseline (see CI caveat) — record them in
your report but do not fix them; failures in the three in-scope files are
yours to fix.

## Gated option — widen the fleet walk (DO NOT EXECUTE; operator decision)

This section is information for Leo, not an executor step. The default for
this plan is: the walk behavior does NOT change.

**The gap**: `fleet-exceptions.ts:234` (`repos = readdirSync(devRoot)`) walks
`~/dev` at depth 1 only. Repos live under grouping dirs too, so the feed
silently misses most of the fleet. Fresh stat (2026-07-11):

- **Read today (depth 1)**: `brown` 2.88 MB, `cc` 2.95 MB,
  `central-planning` 13.6 MB — 3 stores, ~19.5 MB per refresh.
- **Missed (depth 2)**: 18 stores, ~20.6 MB — all of `~/dev/personal/*`
  (12 stores incl. **nx itself**, 1.38 MB; `nv` 3.0 MB) and
  `~/dev/priceless/*` (6 stores incl. `otaku-odyssey` 10.25 MB,
  `tribal-cities` 2.6 MB).

**Why it is gated**: widening roughly doubles refresh read volume
(~19.5 MB → ~40 MB) and changes feed CONTENT — 18 new repos' P0/P1/stale/
unarchived exceptions would start appearing on every dashboard that consumes
`GET /exceptions`, and `FleetExceptionEntry.repo` would need to become a
relative path (`"personal/nexus"`) to stay unambiguous, which is a
wire-visible shape change for Swift/statusline consumers. That is a product
decision, not a perf fix. A bead tracking this decision is filed separately
by the advisor; it is NOT this executor's to resolve.

**If (and only if) Leo approves later**: implement as a bounded two-level
walk — treat a depth-1 dir containing `.beads/` as a repo; otherwise scan its
children once for `.beads/`; never recurse further — as a NEW plan with its
own test fixtures (nested `writeRepo` variants) and a consumer-impact check
on `FleetExceptionEntry.repo`.

## Test plan

- No new test cases: the conversion is behavior-preserving by contract, and
  coverage already exists on both sides of the seam —
  - the 6 updated `beads-reader` tests exercise `readViaJsonl`/`discoverDolt`
    directly through their new async signatures (valid/corrupt/missing/empty
    stores; embedded-mode and sidecar-port discovery);
  - the 6 `computeFleetExceptions` fixture tests (`fleet-exceptions.test.ts:252-309`)
    use the default `readStore = readBeadsStore` against real tmp stores, so
    they drive the full async chain including the new yield.
- Structural pattern to mimic if any test edit goes beyond adding
  `async`/`await`: the existing blocks in the same file (fixture helpers
  `makeDevRoot`/`writeRepo`, `afterEach` cleanup).
- Verification: `cd apps/agent && bun test src/lib/fleet-exceptions.test.ts`
  → `18 pass / 0 fail, 30 expect() calls` (same counts as the 2026-07-11
  baseline).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "readFileSync" apps/agent/src/lib/beads-reader.ts` → no output (exit 1)
- [ ] `grep -n 'from "node:fs/promises"' apps/agent/src/lib/beads-reader.ts` → one hit
- [ ] `grep -cn "async function" apps/agent/src/lib/beads-reader.ts` → `readViaJsonl`, `discoverDolt`, `readBeadsStore`, `loadMysql` all async (4 named + readViaDolt = grep `-n "export async function"` shows readViaDolt, readBeadsStore, readViaJsonl, discoverDolt)
- [ ] `grep -n "Bun.sleep(0)" apps/agent/src/lib/fleet-exceptions.ts` → one hit
- [ ] `grep -n "readdirSync(devRoot)" apps/agent/src/lib/fleet-exceptions.ts` → still exactly one hit (walk NOT widened)
- [ ] `cd apps/agent && bun test src/lib/fleet-exceptions.test.ts` → `18 pass / 0 fail`
- [ ] `pnpm typecheck` exit 0 and `pnpm lint` exit 0 (or: any failures demonstrably pre-existing and not attributable to the three changed files — record which)
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row for 028 updated, with `spec-impact:` appended

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows changes to any in-scope file and the "Current state"
  excerpts no longer match the live code.
- Step 1's importer grep finds `readViaJsonl` or `discoverDolt` imported
  anywhere beyond `beads-reader.ts` + `fleet-exceptions.test.ts` — the async
  conversion would then break an unplanned caller.
- The fleet-exceptions suite fails twice after a reasonable fix attempt.
- `pnpm typecheck` reports an error in a file OUTSIDE the three in-scope
  files that appears only with your change applied (stash-isolate to check).
- You find yourself editing `routes/exceptions.ts`, the statusline app, or
  widening the walk — all out of scope.
- The assumption "`readBeadsStore` is the only production caller of
  `readViaJsonl`/`discoverDolt`" turns out false.

## Maintenance notes

- **If the walk-widening option is later approved** (see Gated option), the
  yield added in Step 6 and the async reads are what make an ~40 MB refresh
  tolerable — do not remove them in that change; DO re-measure refresh
  duration and consider whether `FleetExceptionEntry.repo` becoming a
  relative path breaks Swift/statusline consumers before shipping.
- **Reviewer focus**: (1) the `return await` in `readBeadsStore` (a bare
  `return` would silently break the never-throws contract on a rejected
  promise); (2) that `discoverDolt`'s outer try/catch still swallows the
  port-sidecar race; (3) that no `readdirSync`/`statSync`/`existsSync` call
  was "helpfully" converted — those are deliberate leave-as-is.
- **Deferred out of this plan**: converting the sub-ms `existsSync`/`statSync`
  metadata stats (noise); the depth-1 walk gap (operator-gated, bead filed
  separately); any statusline work (plan 031); re-greening lint-sql-safety
  (plan 023).

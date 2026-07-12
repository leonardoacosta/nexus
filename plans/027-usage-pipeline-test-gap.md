# Plan 027: Close the usage-consolidation test gap — real statusline test script + statusline-usage-file suite

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index. When you mark the row DONE/BLOCKED/REJECTED you MUST
> append `spec-impact: <slug>[, ...]` or `spec-impact: none` to the row.
>
> **Drift check (run first)**:
> `git diff --stat b7096486..HEAD -- apps/nexus-statusline/package.json apps/agent/src/services/statusline-usage-file.ts apps/agent/src/services/credential-refresh-job.test.ts apps/agent/src/credentials/active-credential-watcher.ts`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. (At plan-writing time HEAD was
> `d458ef8e`, one commit past `b7096486` — that commit touched only
> `.beads/issues.jsonl`; all in-scope files were byte-identical to
> `b7096486`. Leo works directly in this repo, so expect further drift.)

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none hard. If plan `plans/026-*` is executing concurrently
  (it may add tests to `apps/nexus-statusline/src/index.test.ts`), prefer
  sequencing this plan AFTER it — this plan wires that suite into the turbo
  gate, and running the wiring step against a mid-edit suite produces
  confusing baselines. This plan itself never edits `index.test.ts`.
- **Category**: tests
- **Planned at**: commit `b7096486`, 2026-07-11

## Why this matters

Two verified gaps in the usage-consolidation pipeline's test story:

1. **False-green gate surface** (findings ARCH-03 / SL-05, CONFIRMED): the
   root quality gate `pnpm test` runs `turbo test`, which fans out to each
   package's `test` script. `apps/nexus-statusline/package.json:13` is still
   the stub `"test": "echo 'no tests yet'"` — despite a live 1309-line,
   113-test suite at `apps/nexus-statusline/src/index.test.ts` (it includes
   the CTX-inversion guard tests). Only a direct root `bun test` discovers
   the suite. Any turbo-gated pipeline (including CI's test job) reports
   green for this package without running a single statusline test.

2. **Untested linchpin** (finding AGENT-NEW-04, CONFIRMED): the agent's
   `writeStatuslineUsageFile` (`apps/agent/src/services/statusline-usage-file.ts`)
   is now the ONLY writer of `~/.claude/scripts/state/usage-cache.json`, and
   the agent poller is the SOLE caller of Anthropic's usage endpoint — the
   statusline just reads this file. A silent regression here (shape drift vs
   the statusline's `CachedUsage` reader, a skip branch firing spuriously)
   freezes usage bars fleet-wide with only a debug-level log trail. Every
   peer service in the same delta ships a dedicated suite
   (`bead-rollup.test.ts`, `paste.test.ts`, `capture.test.ts`, ...); this one
   has zero coverage — repo-wide grep of `*.test.ts` for
   `writeStatuslineUsageFile|statusline-usage-file` returns 0 hits.

After this plan: `pnpm --filter @nexus/statusline test` actually runs the
113-test suite, and the writer half of the usage-cache contract is locked by
a colocated unit suite.

## Current state

Facts verified by fresh reads at `b7096486` (working tree identical for these files):

- `apps/nexus-statusline/package.json` — lines 9–15:

  ```json
  "scripts": {
    "dev": "bun run src/index.ts",
    "build": "bun build src/index.ts --compile --outfile nexus-statusline",
    "lint": "eslint .",
    "test": "echo 'no tests yet'",
    "typecheck": "tsc --noEmit"
  },
  ```

  Runtime proof of the false green: `pnpm --filter @nexus/statusline test`
  currently prints only `no tests yet` and exits 0, while
  `bun test apps/nexus-statusline` runs 113 pass / 0 fail.

- Root `package.json` has `"test": "turbo test"`; `turbo.json` defines the
  `test` task (`"cache": false`, `"env": ["POSTGRES_URL"]`). turbo runs each
  package's `test` script with cwd = the package dir, so
  `bun test src/index.test.ts` is the correct package-relative form.

- `apps/agent/src/services/statusline-usage-file.ts` — the module under
  test. Key excerpts (line numbers from fresh read):

  - `:53-55` `usageCachePath()` → `join(homedir(), ".claude", "scripts", "state", "usage-cache.json")`
  - `:58-61` `utilizationPct(used, limit)` → `if (!limit || limit <= 0) return 0;` else `((used ?? 0) / limit) * 100` — the zero-limit branch.
  - `:64-73` `toPeriod(used, limit, resetAt)` → returns `undefined` when
    `used === null && limit === null`; adds `resets_at: resetAt.toISOString()`
    only when `resetAt` is truthy.
  - `:82-146` `export async function writeStatuslineUsageFile(db: Db): Promise<void>` —
    the ONLY export. Entire body is wrapped in `try/catch`; the catch logs a
    warn and returns (fail-soft, never throws).
    - `:84-88` skip #1: `getActiveCredentialSnapshot().fingerprint` falsy → debug log, return.
    - `:92-105` db read: `db.select({...7 columns...}).from(credentials).where(eq(credentials.fingerprint, fingerprint)).orderBy(desc(credentials.usagePolledAt)).limit(1)` — awaited, destructured `const [row] = ...`.
    - `:107-113` skip #2: `!row || !row.usagePolledAt` → debug log, return.
    - `:115-124` builds `data` from `toPeriod(...)` per window; skip #3 when
      `!data.five_hour && !data.seven_day` → debug log, return.
    - `:126-137` writes payload `{ fetched_at: Math.floor(Date.now()/1000), data }`
      atomically: `tmp = \`${path}.tmp.${process.pid}\``, `mkdirSync(dirname(path), { recursive: true })`,
      `writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 })`, `renameSync(tmp, path)`.
  - Imports (`:25-34`): named imports `mkdirSync, renameSync, writeFileSync`
    from `node:fs`; `credentials` + `type Db` from `@nexus/db`; `desc, eq`
    from `drizzle-orm`; `getActiveCredentialSnapshot` from
    `../credentials/active-credential-watcher`.

- Reader contract this file must keep matching —
  `apps/nexus-statusline/src/index.ts`:

  - `:122-135` the reader-side interfaces:

    ```ts
    interface UsagePeriod { utilization: number; resets_at?: string; }
    interface UsageResponse { five_hour?: UsagePeriod; seven_day?: UsagePeriod; }
    interface CachedUsage { fetched_at: number; data: UsageResponse; }
    ```

  - `:421-423` reader path: `join(homedir(), ".claude/scripts/state/usage-cache.json")` — same resolved path as the writer.
  - `:461-469` `getPolledUsage()` does `JSON.parse(readFileSync(...))` then
    `return cached?.data ?? null;` — so the top-level keys and 0–100
    `utilization` numbers are the whole contract.

- Test seams that make this testable WITHOUT touching the source:

  - `apps/agent/src/credentials/active-credential-watcher.ts:326-331`
    exports `_resetActiveCredentialSnapshotForTest()` (fingerprint → null),
    and `:340-344` exports `__testing = { runRefresh, resetSnapshot, getSnapshot }`.
    `runRefresh(pool, credentialPath)` reads a credentials blob from
    `credentialPath`, calls `pool.list()` then `pool.add(...)`, and on
    success sets the shared snapshot's fingerprint — this is the sanctioned
    way to make `getActiveCredentialSnapshot()` return a non-null
    fingerprint in a test.
  - Exemplar using BOTH seams: `apps/agent/src/services/credential-refresh-job.test.ts`
    — `fakeDb(...)` chain stub at `:33-47`
    (`select→from→where` returning `Promise.resolve(rows)`, cast
    `as unknown as Db`), `activeTesting.resetSnapshot()` in `beforeEach`
    (`:54-56`), and the `runRefresh` drive with a tmpdir credentials file +
    fake pool at `:289-297`:

    ```ts
    const fakeWatcherPool = {
      list: async () => [{ id: "n/a", fingerprint: activeFingerprint }],
      add: async () => "updated" as const,
    };
    await activeTesting.runRefresh(fakeWatcherPool, credPath);
    ```

- **Empirically verified Bun mechanics** (probed on this machine, Bun
  v1.3.11, 2026-07-11 — do not re-derive):
  - `spyOn(fsNamespace, "writeFileSync")` on `import * as fs from "node:fs"`
    DOES intercept named-import `writeFileSync` calls made inside another
    module. Same for spies on local-module namespaces. This is the mechanism
    step 2 relies on.
  - Setting `process.env.HOME` at runtime does NOT change what Bun's
    `os.homedir()` returns — a temp-HOME redirect is NOT a viable way to
    keep the test off the real `~/.claude/scripts/state/usage-cache.json`.
    That is why the fs calls must be spied, never allowed through: an
    unspied run would clobber the live usage cache on the operator's
    machine.
  - Project memory rule: agent tests must use restorable `spyOn` +
    `mockRestore()`, NEVER `bun:test`'s `mock.module` — `mock.module` is
    process-global and leaks forward into later test files in a full-suite
    run (documented contamination incident).

- Repo/CI context: pnpm+Bun monorepo (NOT standard T3 — no tRPC). CI
  (`.github/workflows/ci.yml`) runs typecheck / lint / lint:sql-safety /
  test and is RED on main since 2026-07-10 solely due to a
  `scripts/lint-sql-safety.sh` false positive (plan 023 fixes it). Until 023
  lands, this plan's bar is "no NEW failures attributable to changed files",
  not "CI green".

## Commands you will need

| Purpose | Command (run from repo root / worktree root) | Expected on success |
|---------|----------------------------------------------|---------------------|
| Install | `pnpm install` | exit 0 |
| Typecheck (all) | `pnpm typecheck` | exit 0 for `@nexus/statusline` and `@nexus/agent` (see note) |
| Statusline suite via turbo surface | `pnpm --filter @nexus/statusline test` | after step 1: `>= 113 pass`, `0 fail` |
| New suite only | `bun test apps/agent/src/services/statusline-usage-file.test.ts` | all pass, 0 fail |
| Sanity: existing sibling suite | `bun test apps/agent/src/services/bead-rollup.test.ts` | 27 pass, 0 fail (verified at plan time) |
| Lint | `pnpm lint` | no new errors in changed files |

Notes:
- `pnpm typecheck` note: plans 019/021 recorded pre-existing `TS2307
  bun:test` typecheck failures in `packages/db` (stash-isolated as baseline,
  unrelated). Judge typecheck by: zero errors mentioning your two changed
  files.
- Some agent tests need `NEXUS_ATTACH_SECRET=test` (project memory). The
  sibling `bead-rollup.test.ts` runs clean without it (verified at plan
  time); if your new file fails on a missing attach secret, prefix the test
  command with `NEXUS_ATTACH_SECRET=test`.
- The FULL agent suite (`bun test apps/agent`) has a documented pre-existing
  failure baseline from mock contamination (plan 020 recorded 14 pre-existing
  fails). Do NOT try to fix those; your gate is the targeted file commands
  above.

## Scope

**In scope** (the only files you may create/modify):
- `apps/nexus-statusline/package.json` — line 13 only (`test` script value).
- `apps/agent/src/services/statusline-usage-file.test.ts` — CREATE.

**Out of scope** (do NOT touch, even though they look related):
- `apps/agent/src/services/statusline-usage-file.ts` — behavior changes are
  explicitly NOT this plan's scope. If the code as-is cannot be tested
  without modifying it, that is a STOP condition, not a refactor license.
- `apps/nexus-statusline/src/index.ts` and `src/index.test.ts` — owned by
  concurrent plans (025/026 statusline surface; 031 owns the structural
  split). This plan only WIRES the existing suite into turbo.
- `apps/agent/src/services/credential-usage-poller.{ts,test.ts}` — at plan
  time these carried uncommitted WIP from Leo's live session. Never stage or
  revert them.
- `apps/agent/src/index.ts` (the production `onTickComplete` wiring at
  `:273`) — integration wiring is not under test here.
- `scripts/lint-sql-safety.sh` / CI workflow — plan 023's territory.
- `apps/nexus-statusline` dependency changes — adding `@nexus/core` to the
  statusline is a design decision owned by the security/spawn plan track,
  not this test plan. Do not add dependencies anywhere.

## Git workflow

- This plan is expected to execute in a worktree (repo convention: plans
  execute in worktrees; Leo works directly on `main` in the primary
  checkout).
- Branch: `advisor/027-usage-pipeline-test-gap` (matches prior
  `advisor/NNN-slug` rows in `plans/README.md`).
- Stage ONLY the two in-scope paths by name — never `git add .`/`-A` (shared
  tree; uncommitted WIP exists in `credential-usage-poller.*`).
- One commit, conventional style, e.g.:
  `test(agent): cover writeStatuslineUsageFile; wire statusline suite into turbo test`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Point the statusline `test` script at the real suite

In `apps/nexus-statusline/package.json`, change line 13 from:

```json
    "test": "echo 'no tests yet'",
```

to:

```json
    "test": "bun test src/index.test.ts",
```

(Path is package-relative because turbo/pnpm run scripts with cwd =
`apps/nexus-statusline`.)

**Verify**: `pnpm --filter @nexus/statusline test`
→ output ends with a bun test summary of `>= 113 pass`, `0 fail` (113 exactly
at plan time; a concurrent plan 026 may have added tests — more passes is
fine, any `fail` is not). If it still prints `no tests yet`, you edited the
wrong file/line.

### Step 2: Create `apps/agent/src/services/statusline-usage-file.test.ts`

Model the file on `apps/agent/src/services/credential-refresh-job.test.ts`
(fake-Db chain stub + `active-credential-watcher` test seams) — that is the
structural exemplar. Target shape:

```ts
/**
 * Unit tests for statusline-usage-file.ts (plan 027).
 *
 * writeStatuslineUsageFile is the SOLE writer of
 * ~/.claude/scripts/state/usage-cache.json (read by nexus-statusline's
 * getPolledUsage). These tests stub the db chain, drive the active-credential
 * snapshot via the watcher's __testing seam, and spy node:fs so NOTHING is
 * written to the real home directory. Restorable spyOn only — never
 * mock.module (process-global, leaks into later test files).
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "@nexus/db";
import { writeStatuslineUsageFile } from "./statusline-usage-file";
import { __testing as activeTesting } from "../credentials/active-credential-watcher";

// Row shape = the 7 columns writeStatuslineUsageFile selects.
interface UsageRow {
  usage5hUsed: number | null;
  usage5hLimit: number | null;
  usage5hResetAt: Date | null;
  usage7dUsed: number | null;
  usage7dLimit: number | null;
  usage7dResetAt: Date | null;
  usagePolledAt: Date | null;
}

/** db stub matching select().from().where().orderBy().limit() → rows. */
function fakeDb(rows: UsageRow[], calls?: { selects: number }): Db {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return {
    select: () => {
      if (calls) calls.selects += 1;
      return chain;
    },
  } as unknown as Db;
}

/** db stub whose awaited read rejects (fail-soft catch path). */
function rejectingDb(): Db {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.reject(new Error("pg exploded")),
  };
  return { select: () => chain } as unknown as Db;
}

const EXPECTED_PATH = join(homedir(), ".claude", "scripts", "state", "usage-cache.json");
const EXPECTED_TMP = `${EXPECTED_PATH}.tmp.${process.pid}`;

describe("writeStatuslineUsageFile", () => {
  let writeSpy: ReturnType<typeof spyOn>;
  let renameSpy: ReturnType<typeof spyOn>;
  let mkdirSpy: ReturnType<typeof spyOn>;
  let written: Array<{ path: string; data: string; mode: number | undefined }>;
  let renamed: Array<{ from: string; to: string }>;

  beforeEach(() => {
    activeTesting.resetSnapshot();
    written = [];
    renamed = [];
    // Spy — never let the real fs calls through (they'd clobber the live
    // usage-cache.json in the operator's home dir).
    writeSpy = spyOn(fs, "writeFileSync").mockImplementation(((
      p: fs.PathOrFileDescriptor, d: string, o?: fs.WriteFileOptions,
    ) => {
      written.push({
        path: String(p),
        data: String(d),
        mode: typeof o === "object" && o !== null ? (o.mode as number) : undefined,
      });
    }) as never);
    renameSpy = spyOn(fs, "renameSync").mockImplementation(((f: fs.PathLike, t: fs.PathLike) => {
      renamed.push({ from: String(f), to: String(t) });
    }) as never);
    mkdirSpy = spyOn(fs, "mkdirSync").mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    renameSpy.mockRestore();
    mkdirSpy.mockRestore();
    activeTesting.resetSnapshot();
  });

  /** Point the shared snapshot at a real fingerprint via the sanctioned seam. */
  async function activateFingerprint(): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "nx-usage-file-"));
    const credPath = join(dir, ".credentials.json");
    await writeFile(
      credPath,
      JSON.stringify({ claudeAiOauth: { accessToken: "at-test", refreshToken: "rt-test" } }),
    );
    const fakeWatcherPool = {
      list: async () => [],
      add: async () => "updated" as const,
    };
    await activeTesting.runRefresh(fakeWatcherPool, credPath);
    await rm(dir, { recursive: true, force: true });
    expect(activeTesting.getSnapshot().fingerprint).not.toBeNull();
  }

  const FULL_ROW: UsageRow = {
    usage5hUsed: 41,
    usage5hLimit: 50,
    usage5hResetAt: new Date("2030-01-01T00:00:00.000Z"),
    usage7dUsed: 220,
    usage7dLimit: 1000,
    usage7dResetAt: new Date("2030-01-08T00:00:00.000Z"),
    usagePolledAt: new Date(),
  };

  it("skips (no db read, no write) when there is no active fingerprint", async () => {
    const calls = { selects: 0 };
    await writeStatuslineUsageFile(fakeDb([FULL_ROW], calls));
    expect(calls.selects).toBe(0);
    expect(written).toHaveLength(0);
    expect(renamed).toHaveLength(0);
  });

  it("skips when no credential row matches the fingerprint", async () => {
    await activateFingerprint();
    await writeStatuslineUsageFile(fakeDb([]));
    expect(written).toHaveLength(0);
  });

  it("skips when the row has never been polled (usagePolledAt null)", async () => {
    await activateFingerprint();
    await writeStatuslineUsageFile(fakeDb([{ ...FULL_ROW, usagePolledAt: null }]));
    expect(written).toHaveLength(0);
  });

  it("skips when both windows are empty (toPeriod → undefined twice)", async () => {
    await activateFingerprint();
    await writeStatuslineUsageFile(
      fakeDb([{
        usage5hUsed: null, usage5hLimit: null, usage5hResetAt: null,
        usage7dUsed: null, usage7dLimit: null, usage7dResetAt: null,
        usagePolledAt: new Date(),
      }]),
    );
    expect(written).toHaveLength(0);
  });

  it("writes the CachedUsage shape the statusline reader parses", async () => {
    await activateFingerprint();
    const before = Math.floor(Date.now() / 1000);
    await writeStatuslineUsageFile(fakeDb([FULL_ROW]));
    expect(written).toHaveLength(1);
    const payload = JSON.parse(written[0]!.data) as {
      fetched_at: number;
      data: {
        five_hour?: { utilization: number; resets_at?: string };
        seven_day?: { utilization: number; resets_at?: string };
      };
    };
    // Contract vs apps/nexus-statusline/src/index.ts:132-135 (CachedUsage):
    // top-level keys exactly { fetched_at, data }, utilization 0–100.
    expect(Object.keys(payload).sort()).toEqual(["data", "fetched_at"]);
    expect(payload.fetched_at).toBeGreaterThanOrEqual(before);
    expect(payload.fetched_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(payload.data.five_hour?.utilization).toBe(82); // 41/50*100
    expect(payload.data.five_hour?.resets_at).toBe("2030-01-01T00:00:00.000Z");
    expect(payload.data.seven_day?.utilization).toBe(22); // 220/1000*100
    expect(payload.data.seven_day?.resets_at).toBe("2030-01-08T00:00:00.000Z");
  });

  it("zero or null limit yields utilization 0, never NaN/Infinity", async () => {
    await activateFingerprint();
    await writeStatuslineUsageFile(
      fakeDb([{ ...FULL_ROW, usage5hLimit: 0, usage7dLimit: null }]),
    );
    const payload = JSON.parse(written[0]!.data);
    expect(payload.data.five_hour.utilization).toBe(0);
    expect(payload.data.seven_day.utilization).toBe(0);
  });

  it("omits a window with no data instead of writing an empty object", async () => {
    await activateFingerprint();
    await writeStatuslineUsageFile(
      fakeDb([{ ...FULL_ROW, usage7dUsed: null, usage7dLimit: null, usage7dResetAt: null }]),
    );
    const payload = JSON.parse(written[0]!.data);
    expect("seven_day" in payload.data).toBe(false);
    expect(payload.data.five_hour.utilization).toBe(82);
  });

  it("omits resets_at when the reset timestamp is null", async () => {
    await activateFingerprint();
    await writeStatuslineUsageFile(
      fakeDb([{ ...FULL_ROW, usage5hResetAt: null }]),
    );
    const payload = JSON.parse(written[0]!.data);
    expect("resets_at" in payload.data.five_hour).toBe(false);
  });

  it("writes atomically: pid-suffixed tmp file, mode 0o600, rename to final path", async () => {
    await activateFingerprint();
    await writeStatuslineUsageFile(fakeDb([FULL_ROW]));
    expect(written[0]!.path).toBe(EXPECTED_TMP);
    expect(written[0]!.mode).toBe(0o600);
    expect(renamed).toEqual([{ from: EXPECTED_TMP, to: EXPECTED_PATH }]);
    expect(mkdirSpy).toHaveBeenCalled();
  });

  it("never throws when the db read rejects (fail-soft)", async () => {
    await activateFingerprint();
    await expect(writeStatuslineUsageFile(rejectingDb())).resolves.toBeUndefined();
    expect(written).toHaveLength(0);
  });

  it("never throws when the file write throws (fail-soft)", async () => {
    await activateFingerprint();
    writeSpy.mockImplementation((() => {
      throw new Error("disk full");
    }) as never);
    await expect(writeStatuslineUsageFile(fakeDb([FULL_ROW]))).resolves.toBeUndefined();
    expect(renamed).toHaveLength(0);
  });
});
```

Adapt types/casts as needed to satisfy the linter and `tsc` — but keep every
`it(...)` case above, the spy-don't-write invariant, and the restorable-spy
discipline. Do not add `mock.module` anywhere.

**Verify**: `bun test apps/agent/src/services/statusline-usage-file.test.ts`
→ `11 pass, 0 fail` (or your exact case count if a cast forces a merge/split
of cases — 0 fail is the hard requirement, and all branches listed above must
be asserted).

### Step 3: Confirm no real file was touched and no fs spy leaked

The suite must be a pure spy suite: after running it, the live cache file
must be whatever it was before.

**Verify**:
```bash
md5sum ~/.claude/scripts/state/usage-cache.json 2>/dev/null > /tmp/plan027-before.md5
bun test apps/agent/src/services/statusline-usage-file.test.ts
md5sum ~/.claude/scripts/state/usage-cache.json 2>/dev/null | diff /tmp/plan027-before.md5 -
```
→ `diff` exits 0 (identical, or both absent). If the file changed, a spy is
not intercepting — STOP (see STOP conditions). Note: the real nexus-agent
poller rewrites this file periodically; if diff fails, re-run the
before/test/after sequence back-to-back once before concluding the test is
at fault (an intervening poller tick changes `fetched_at`).

### Step 4: Gates + sibling-suite sanity

**Verify**:
- `pnpm typecheck` → zero errors mentioning
  `statusline-usage-file.test.ts` or `apps/nexus-statusline/package.json`
  (pre-existing `packages/db` TS2307 bun:test errors are recorded baseline —
  ignore them).
- `pnpm lint` → no new errors in the two changed files.
- `bun test apps/agent/src/services/credential-refresh-job.test.ts` →
  same pass/fail counts as before your change (your seam usage must not
  perturb the exemplar suite; `resetSnapshot` in your `afterEach` guarantees
  the shared watcher snapshot is left null).

### Step 5: Commit

Stage exactly:
```bash
git add apps/nexus-statusline/package.json apps/agent/src/services/statusline-usage-file.test.ts
```
Commit with the message from § Git workflow. Do not push.

**Verify**: `git status --porcelain` → shows no staged files left, and the
only unstaged noise (if executing in the primary checkout rather than a
worktree) is pre-existing WIP you never touched
(`credential-usage-poller.*`, `.beads/issues.jsonl`).

## Test plan

- New file: `apps/agent/src/services/statusline-usage-file.test.ts` (step 2)
  covering: no-fingerprint skip (db never queried), no-row skip,
  never-polled skip, empty-windows skip, happy-path CachedUsage shape
  contract (exact top-level keys, 0–100 utilization math, ISO `resets_at`,
  epoch-seconds `fetched_at`), zero/null-limit → utilization 0, absent
  window omitted, `resets_at` omitted when null, atomic tmp+rename with pid
  suffix + mode 0o600, db-reject fail-soft, write-throw fail-soft.
- Structural pattern: `apps/agent/src/services/credential-refresh-job.test.ts`
  (fake Db chain `:33-47`, watcher seam drive `:289-297`, `resetSnapshot`
  in `beforeEach`).
- Existing suite newly wired into the gate (step 1):
  `apps/nexus-statusline/src/index.test.ts` — not modified, just executed by
  `pnpm --filter @nexus/statusline test`.
- Verification commands and expected outputs are inlined per step above.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n '"test"' apps/nexus-statusline/package.json` → shows
      `"test": "bun test src/index.test.ts"` (the `echo 'no tests yet'` stub is gone).
- [ ] `pnpm --filter @nexus/statusline test` → bun test summary with `0 fail`
      and `>= 113 pass`.
- [ ] `bun test apps/agent/src/services/statusline-usage-file.test.ts` →
      `0 fail`, `>= 11` tests, covering every case named in the Test plan.
- [ ] Step 3 md5 diff → live `usage-cache.json` unchanged by the suite.
- [ ] `pnpm typecheck` and `pnpm lint` → zero errors attributable to the two
      changed files (pre-existing `packages/db` TS2307 baseline excluded;
      CI-wide red from `lint-sql-safety` is plan 023's, not yours).
- [ ] `git diff --name-only HEAD~1..HEAD` (your commit) → exactly
      `apps/nexus-statusline/package.json` and
      `apps/agent/src/services/statusline-usage-file.test.ts`.
- [ ] `plans/README.md` status row for 027 updated, with
      `spec-impact: <slug>[, ...]` or `spec-impact: none` appended.

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows changes to `statusline-usage-file.ts` and its
  excerpts no longer match (e.g. the skip branches moved, the export list
  grew, or the write path changed) — the test targets would be stale.
- `apps/nexus-statusline/package.json:13` is no longer the
  `echo 'no tests yet'` stub (another plan/session may have already wired
  it — report, don't double-edit).
- Step 1's verify still prints `no tests yet`, or the suite reports any
  `fail` at baseline (a concurrent statusline plan may have left the suite
  red — that failure is not yours to fix).
- The `spyOn(fs, ...)` interception does not work (step 3's md5 diff shows
  the live file changed, or `written` stays empty on the happy path). The
  probe verified interception on Bun v1.3.11; a different Bun version may
  behave differently. Do NOT fall back to `mock.module` and do NOT let real
  writes through — report.
- `activeTesting.runRefresh` no longer sets a fingerprint with the fake pool
  + tmpdir blob (watcher seam drifted).
- You find yourself needing to edit `statusline-usage-file.ts` (e.g. to
  export `toPeriod`/`utilizationPct` or inject the path) to make a case
  testable — that is a source change, explicitly out of scope.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **This suite is the writer half of a cross-app contract.** The reader half
  lives in `apps/nexus-statusline/src/index.ts` (`CachedUsage`,
  `getPolledUsage`). If either side's shape changes, change BOTH and update
  the shape-contract test here — plan 031 (statusline god-module split) will
  move the reader; the contract assertions in this suite are what catches a
  drift it introduces.
- Reviewer scrutiny points: (1) the fs spies must cover ALL three of
  `writeFileSync`/`renameSync`/`mkdirSync` and be restored in `afterEach` —
  a missing restore leaks into later files in a full-suite run; (2) the
  package.json change is one line — any other diff in that file is scope
  creep.
- Deferred out of this plan (tracked elsewhere): a staleness ceiling in the
  statusline's `getPolledUsage` (agent-new-services seam recommendation),
  the `writeSessionContext` docstring reconciliation (settled: guard is
  by-design; docstring polish only), gateway-passthrough dedup, and any
  statusline `@nexus/core`/safeSpawn adoption.
- Full-suite agent runs still carry the pre-existing mock-contamination
  failure baseline; this plan neither worsens nor fixes it. If that baseline
  is ever cleaned up, this suite should already be clean (spyOn-only).

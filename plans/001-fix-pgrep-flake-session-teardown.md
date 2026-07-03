# Plan 001: Guard the process-watcher against a transient pgrep failure marking every live session ended

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 64a206ff..HEAD -- apps/agent/src/services/process-watcher.ts apps/agent/src/services/process-watcher.test.ts apps/agent/src/utils/exec.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `64a206ff`, 2026-07-03

## Why this matters

`listClaudeProcesses()` collapses ANY pgrep failure (except the benign
exit-code-1 "no matches") into an empty process list. A single flaky pgrep
tick — a 10s exec timeout under fork pressure on a busy daemon — therefore
looks identical to "no claude is running". The reconciliation pass then marks
EVERY open managed session `status = "ended"`, fires a `RemoteSessionEnded`
storm to every SSE/dashboard client, and the next successful tick re-inserts
those sessions with brand-new session IDs. Session identity and history churn;
downstream clients see a phantom mass teardown. This plan makes a scan failure
distinguishable from an empty match set so a failed scan leaves managed rows
untouched instead of closing them all.

## Current state

Files:

- `apps/agent/src/services/process-watcher.ts` — the watcher. `listClaudeProcesses()` (the pgrep scan) and `reconcileOnce()` (the diff pass that closes/creates rows) both live here.
- `apps/agent/src/utils/exec.ts` — `execText()` plus the `ExecError` / `ExecTimeoutError` classes it throws.
- `apps/agent/src/services/process-watcher.test.ts` — existing bun test suite for `reconcileOnce`; the mock harness for `pgrep`/`tmux`/resolver lives at the top.

### The bug: failure collapses to empty list

`apps/agent/src/services/process-watcher.ts:182-214`:

```ts
async function listClaudeProcesses(): Promise<LiveProcess[]> {
  let stdout: string;
  try {
    stdout = await execText("pgrep", ["-af", "claude"]);
  } catch (err) {
    // pgrep exits 1 when nothing matches; that's not an error.
    const exitCode =
      err instanceof Error && "exitCode" in err
        ? (err as { exitCode?: number }).exitCode
        : undefined;
    if (exitCode === 1) return [];
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "pgrep failed; skipping reconciliation pass",
    );
    return [];                       // <-- BUG: failure looks like "no claude running"
  }
  // ...parse stdout into LiveProcess[]...
  return procs;
}
```

The log line says "skipping reconciliation pass" but the code does NOT skip —
it returns `[]`, which the caller treats as "nothing alive" and proceeds to
close every managed row.

### Why a timeout can't be told apart from exit-1

`apps/agent/src/utils/exec.ts:32-45` — `ExecError` carries `exitCode`:

```ts
export class ExecError extends Error {
  constructor(
    public readonly cmd: string,
    public readonly args: string[],
    public readonly exitCode: number,
    public readonly stderr: string,
  ) { /* ... */ }
}
```

`apps/agent/src/utils/exec.ts:47-56` — `ExecTimeoutError` has NO `exitCode`
field (only `timeoutMs`):

```ts
export class ExecTimeoutError extends Error {
  constructor(
    public readonly cmd: string,
    public readonly args: string[],
    public readonly timeoutMs: number,
  ) { /* ... */ }
}
```

So a pgrep timeout (`ExecTimeoutError`) has `"exitCode" in err === false`,
falls through the `exitCode === 1` guard, and lands on the `return []` branch —
indistinguishable from a genuine "no matches".

### Where the mass-close happens

`apps/agent/src/services/process-watcher.ts:507-514` builds the live set:

```ts
  let live: LiveProcess[] = [];
  try {
    live = await listClaudeProcesses();
  } catch (err) {
    tickErrorText = err instanceof Error ? err.message : String(err);
    log.warn({ err: tickErrorText }, "listClaudeProcesses threw inside reconcileOnce");
  }
  const livePids = new Set(live.map((p) => p.pid));
  lastLivePidCount = livePids.size;
```

(Note: `listClaudeProcesses` catches internally today, so this outer catch
never fires for a pgrep failure — the failure is already swallowed to `[]`.)

`apps/agent/src/services/process-watcher.ts:573-632` — the per-row loop; the
close branch at 614-631 ends every open managed row whose pid is not in
`livePids`:

```ts
  for (const row of openRows) {
    const pid = row.pid;
    if (pid === null || pid <= 0) continue;
    managedPids.add(pid);
    if (livePids.has(pid)) {
      // ...heartbeat / tmux backfill / enrichment (happy path)...
    }
    if (!livePids.has(pid)) {
      try {
        await db
          .update(sessions)
          .set({ status: "ended", endedAt: now, lastActivity: now })
          .where(eq(sessions.id, row.id));
        closed += 1;
        lifecycleBus.emit("RemoteSessionEnded", {
          sessionId: row.id,
          pid,
        });
      } catch (err) {
        log.warn(/* ... */ "failed to close session row");
      }
    }
  }
```

When `listClaudeProcesses` returned `[]` because of a failure, `livePids` is
empty, so `!livePids.has(pid)` is true for every managed row → all closed.

### Conventions to match

- Logging: pino via `const log = createLogger("agent:process-watcher");` (line 67). Reuse `log.warn`/`log.error` with a structured first arg.
- Runtime: Bun. Never `tsc` for execution.
- Test-only exports are collected in `export const __testing = { ... }` at `apps/agent/src/services/process-watcher.ts:1088-1096`.
- Tests: bun's test runner (`import { describe, test, expect, ... } from "bun:test"`). The suite mocks `../utils/exec` via `mock.module(...)` at `process-watcher.test.ts:68-101` and gates DB tests behind `describe.skipIf(!hasPg)` (`process-watcher.test.ts:277`).

## Commands you will need

| Purpose   | Command                                                        | Expected on success        |
|-----------|---------------------------------------------------------------|----------------------------|
| Install   | `pnpm install`                                                | exit 0                     |
| Typecheck | `pnpm typecheck`                                              | exit 0, no errors          |
| Lint      | `pnpm lint`                                                   | exit 0                     |
| Tests     | `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test process-watcher` | all pass, incl. new tests |

Notes:
- `pnpm typecheck` and `pnpm lint` run from the repo root (turbo).
- The watcher's row-mutation tests require a live Postgres (`POSTGRES_URL`) — they are skipped cleanly otherwise via `describe.skipIf(!hasPg)`. `NEXUS_ATTACH_SECRET=test` is required for the agent test bootstrap. If `POSTGRES_URL` is unset, the DB-backed tests SKIP rather than fail — that is acceptable for local verification but note it in your report so a reviewer runs them against PG.

## Scope

**In scope** (the only files you should modify):
- `apps/agent/src/services/process-watcher.ts`
- `apps/agent/src/services/process-watcher.test.ts`

**Out of scope** (do NOT touch, even though they look related):
- `apps/agent/src/utils/exec.ts` — do NOT add an `exitCode` to `ExecTimeoutError` or otherwise change the exec layer. The fix is a distinct return signal from `listClaudeProcesses`, which is strictly local to the watcher and does not risk other exec callers.
- The happy path in `reconcileOnce` (heartbeat, tmux backfill, enrichment, new-row insert). Only the close-loop guard and the failure-signal plumbing change.
- The `listChildren` pgrep helper (`process-watcher.ts:417-439`) — its empty-on-failure behaviour is correct for a descendant walk (a failed child scan should just yield no descendants, never close rows).

## Git workflow

- Branch: `advisor/001-fix-pgrep-flake` (create it; do NOT work on `main`).
- Commit style: conventional commits, e.g. `fix(agent): distinguish pgrep scan failure from empty match set in process-watcher`. (Repo convention — recent log: `fix(deploy): auto iOS device deploy hook ...`.)
- Do NOT push or open a PR.

## Steps

### Step 1: Make `listClaudeProcesses` signal failure as `null`

In `apps/agent/src/services/process-watcher.ts`, change `listClaudeProcesses`
so a genuine failure returns `null` while an empty match set (exit-1 or an
empty successful scan) still returns `[]`.

Target shape:

```ts
/**
 * Run `pgrep -af claude` and return the parsed live `claude` processes.
 * `-a` formats each line as `PID COMMAND…`.
 *
 * Returns `[]` for a genuine empty match set (pgrep exit 1, or a successful
 * scan with no claude binaries). Returns `null` when the scan itself FAILED
 * (timeout, spawn error, non-1 non-zero exit) so the caller can tell "scan
 * failed" apart from "nothing alive" and refuse to close rows on a flake.
 */
async function listClaudeProcesses(): Promise<LiveProcess[] | null> {
  let stdout: string;
  try {
    stdout = await execText("pgrep", ["-af", "claude"]);
  } catch (err) {
    // pgrep exits 1 when nothing matches; that's a real empty set, not a failure.
    const exitCode =
      err instanceof Error && "exitCode" in err
        ? (err as { exitCode?: number }).exitCode
        : undefined;
    if (exitCode === 1) return [];
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "pgrep failed; skipping row reconciliation this tick (managed rows left untouched)",
    );
    return null;
  }

  const procs: LiveProcess[] = [];
  // ...existing parse loop unchanged...
  return procs;
}
```

Only the return type, the failure-branch `return null` (was `return []`), and
the (now-accurate) log message change. The exit-1 branch and the parse loop are
untouched.

**Verify**: `pnpm typecheck` → exit 0 (the new `| null` return type will force
Step 2 to compile; a lingering error here just means Step 2 isn't done yet —
run typecheck again after Step 2).

### Step 2: Skip the close-loop in `reconcileOnce` when the scan failed

In `apps/agent/src/services/process-watcher.ts`, update the block at lines
507-514 and guard the close branch at 614-631.

At the live-scan site, capture the failure and default to an empty list for the
rest of the pass:

```ts
  let live: LiveProcess[] | null = [];
  try {
    live = await listClaudeProcesses();
  } catch (err) {
    tickErrorText = err instanceof Error ? err.message : String(err);
    log.warn({ err: tickErrorText }, "listClaudeProcesses threw inside reconcileOnce");
    live = null;
  }
  // A null scan means pgrep failed (timeout/spawn error) — NOT "no claude
  // running". Treat this tick as read-only for row closes: leave managed rows
  // untouched rather than mass-closing every live session on one flaky tick.
  const scanFailed = live === null;
  if (scanFailed && tickErrorText === null) {
    tickErrorText = "pgrep scan failed; row reconciliation skipped this tick";
  }
  const liveList = live ?? [];
  const livePids = new Set(liveList.map((p) => p.pid));
  lastLivePidCount = livePids.size;
```

Then, everywhere the pass currently iterates `live`, iterate `liveList`
instead (the new-row insert loop at line 713 — `for (const proc of live)` →
`for (const proc of liveList)`). Any `live.length` reads (e.g. the summary log
at line 819, `"reconciliation pass complete"`, and the `paneByPid`/tmux debug)
become `liveList.length`.

Finally, guard the close branch so a failed scan closes nothing. Change:

```ts
    if (!livePids.has(pid)) {
```

to:

```ts
    if (!scanFailed && !livePids.has(pid)) {
```

Behaviour when `scanFailed` is true: `livePids` is empty, so the alive branch
(`if (livePids.has(pid))`) never runs, the close branch is now skipped, and the
new-row loop iterates an empty `liveList` — so every managed row is left exactly
as it was. `tickErrorText` is set, which the existing `maybeEmitStalled`
(line 841 / 904-924) surfaces as a `ProcessWatcherStalled` event, so the failed
tick is still observable.

**Verify**: `pnpm typecheck` → exit 0, no errors.

### Step 3: Add a regression test for the failed-scan path

In `apps/agent/src/services/process-watcher.test.ts`, extend the mock harness
so a test can force the `pgrep -af claude` call to fail, then add two DB-backed
tests inside the existing `describe.skipIf(!hasPg)(...)` block (after the
"Dead PID → row closed" test around line 353).

First, add a failure toggle to the exec mock. Near the other mock-state setters
(`setPgrepOutput` at line 47), add:

```ts
// When set, the `pgrep -af claude` master scan throws instead of returning
// output — simulates a timeout / spawn failure (NOT exit-1 "no matches").
let pgrepShouldFail: null | "timeout" | { exitCode: number } = null;
function setPgrepFailure(mode: null | "timeout" | { exitCode: number }): void {
  pgrepShouldFail = mode;
}
```

Inside the `mock.module("../utils/exec", ...)` factory (line 68-101), in the
`pgrep -af claude` branch, throw when the toggle is set. The mock already
defines `ExecTimeoutError` and `ExecError` classes in the same factory — use
them so the watcher's `"exitCode" in err` check behaves realistically:

```ts
    // pgrep -af claude — the master live-claude scan.
    if (cmd === "pgrep" && args[0] === "-af" && args[1] === "claude") {
      if (pgrepShouldFail === "timeout") {
        throw new ExecTimeoutError(cmd, args, 10_000);
      }
      if (pgrepShouldFail && typeof pgrepShouldFail === "object") {
        throw new ExecError(cmd, args, pgrepShouldFail.exitCode, "boom");
      }
      return pgrepResponse.lines.join("\n");
    }
```

`ExecTimeoutError`/`ExecError` are referenced before their class declarations
in the object literal — because the factory is a closure invoked at
`mock.module` time (after the classes are assigned), that is fine; but if the
runtime complains about use-before-declaration, hoist the two class
declarations above the `execText` mock inside the same factory. Reset the
toggle in `beforeEach` (line 311-318) alongside the other resets:

```ts
      setPgrepFailure(null);
```

Then add the tests:

```ts
    test("pgrep timeout → managed rows left OPEN, no RemoteSessionEnded emitted", async () => {
      await insertRow(db, { id: "row-a", pid: 100, status: "active" });
      await insertRow(db, { id: "row-b", pid: 200, status: "active" });

      const ended: unknown[] = [];
      const off = lifecycleBus.on("RemoteSessionEnded", (e) => ended.push(e));
      try {
        setPgrepFailure("timeout"); // scan fails — NOT "no claude running"

        const result = await reconcileOnce(db);
        // Nothing closed, nothing created — the tick is read-only on a flake.
        expect(result).toEqual({ created: 0, closed: 0 });
      } finally {
        off();
      }

      // Both rows remain active with a null endedAt.
      const rows = await db.select().from(sessions);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.status).toBe("active");
        expect(row.endedAt).toBeNull();
      }
      // No teardown storm.
      expect(ended).toEqual([]);
    });

    test("pgrep non-1 error exit → rows also left untouched", async () => {
      await insertRow(db, { id: "row-c", pid: 300, status: "active" });
      setPgrepFailure({ exitCode: 2 }); // e.g. pgrep invocation/permission error

      const result = await reconcileOnce(db);
      expect(result).toEqual({ created: 0, closed: 0 });

      const rows = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, "row-c"));
      expect(rows[0]!.status).toBe("active");
      expect(rows[0]!.endedAt).toBeNull();
    });
```

You will need to import `lifecycleBus` in the test file. Confirm the export and
the subscribe API before writing: read `apps/agent/src/services/lifecycle-bus.ts`
and match whatever subscribe method it exposes (the example above assumes
`lifecycleBus.on(event, cb)` returning an unsubscribe function). If the API
differs (e.g. `subscribe`/`addListener`, or no unsubscribe return), adapt the
`ended`-capture accordingly. If wiring a real subscriber proves awkward, an
acceptable fallback is to assert only `result.closed === 0` plus that the rows
stay `active` — the row assertion alone proves the bug is fixed, since
`RemoteSessionEnded` is only emitted on the same close path (line 621) that
`closed` counts.

**Verify**:
`cd apps/agent && NEXUS_ATTACH_SECRET=test bun test process-watcher`
→ all tests pass, including the two new ones. If `POSTGRES_URL` is unset the
new DB tests SKIP — set `POSTGRES_URL` to a throwaway/local PG to actually
exercise them, and say so in your report.

### Step 4: Confirm the existing behaviour still holds

The pre-existing "Dead PID → row closed" (line 338) and "Mixed" (line 355)
tests exercise the genuine-empty and genuine-partial paths — they MUST still
pass unchanged. A real empty scan (`setPgrepOutput([])`, no failure) still
returns `[]`, `scanFailed` is false, and dead rows still close exactly as before.

**Verify**:
`cd apps/agent && NEXUS_ATTACH_SECRET=test bun test process-watcher`
→ every test in the file passes (existing + new).

## Test plan

- New tests, both in `apps/agent/src/services/process-watcher.test.ts`, inside the `describe.skipIf(!hasPg)` block:
  - `pgrep timeout → managed rows left OPEN, no RemoteSessionEnded emitted` — the core regression: an `ExecTimeoutError` from the master scan must NOT close open rows and must NOT emit `RemoteSessionEnded`.
  - `pgrep non-1 error exit → rows also left untouched` — an `ExecError` with `exitCode !== 1` takes the same failure path.
- Structural pattern to model after: the existing "Dead PID → row closed" and "Mixed" tests (`process-watcher.test.ts:338-399`) — same `insertRow` + `reconcileOnce` + row-assertion shape.
- Existing passing behaviour to preserve: exit-1 / empty scan → `[]` → dead rows close normally ("Dead PID → row closed", line 338).
- Verification: `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test process-watcher` → all pass, including 2 new tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test process-watcher` → all pass, including the 2 new failed-scan tests (run against a live `POSTGRES_URL`; if skipped, report it)
- [ ] `listClaudeProcesses` returns `Promise<LiveProcess[] | null>` and the failure branch returns `null` (not `[]`): `grep -n "Promise<LiveProcess\[\] | null>" apps/agent/src/services/process-watcher.ts` returns a match
- [ ] `reconcileOnce` guards the close branch with `!scanFailed`: `grep -n "!scanFailed" apps/agent/src/services/process-watcher.ts` returns a match
- [ ] No files outside the in-scope list are modified (`git status` shows only `process-watcher.ts` + `process-watcher.test.ts`)
- [ ] `plans/README.md` status row updated (if the index exists / you own it)

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts (the codebase drifted since `64a206ff`).
- `reconcileOnce` no longer iterates a local `live` variable, or the close branch has moved out of the `for (const row of openRows)` loop — the guard placement assumptions no longer hold.
- Fixing the bug appears to require editing `apps/agent/src/utils/exec.ts` (e.g. you conclude `ExecTimeoutError` must carry an `exitCode`) — that is explicitly out of scope; report why before proceeding.
- `lifecycleBus` exposes no usable subscribe API for the emission assertion AND the row-only fallback also fails to compile.
- Any verification command fails twice after a reasonable fix attempt.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- `listClaudeProcesses` now has a tri-state contract: `LiveProcess[]` (rows, possibly empty) means "scan succeeded", `null` means "scan failed — do not close rows". Any future caller MUST branch on `null` before treating an empty result as "nothing alive". The sibling helper `listChildren` (descendant walk) deliberately keeps its empty-on-failure behaviour — a failed child scan should yield no descendants, never close rows.
- If pgrep flakes become frequent, consider a consecutive-failure counter that DOES eventually close rows after N failed scans (to avoid pinning genuinely-dead rows open forever). Deliberately deferred here — one flake should never mass-close, and the 30s tick self-heals on the next success.
- Reviewer should scrutinize: that the happy path (heartbeat, tmux backfill, enrichment, new-row insert) is byte-for-byte unchanged except for the `live` → `liveList` rename, and that `scanFailed` gates ONLY the close branch (not the create/enrich paths, which are already no-ops on an empty list).

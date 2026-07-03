# Plan 002: Serialize `reconcileOnce` so a `/sessions/probe` HTTP call cannot race the interval reconcile tick

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 64a206ff..HEAD -- apps/agent/src/services/process-watcher.ts apps/agent/src/services/process-watcher.test.ts apps/agent/src/routes/sessions.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> **Dependency**: This plan depends on `plans/001-fix-pgrep-flake-session-teardown.md`
> (same file, `process-watcher.ts` / `process-watcher.test.ts`). **Land 001
> first.** If `plans/001-*.md` still shows status TODO/IN PROGRESS in
> `plans/README.md`, STOP and report — do not start this plan on top of an
> unmerged 001.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-fix-pgrep-flake-session-teardown.md
- **Category**: bug
- **Planned at**: commit `64a206ff`, 2026-07-03

## Why this matters

`reconcileOnce(db)` is the single reconciliation pass that diffs live `claude`
PIDs against the `sessions` table — inserting a fresh row for every newly-seen
PID and closing rows whose PID vanished. It runs on a 30s interval **and** is
directly callable over HTTP via `POST /sessions/probe` (an externally
triggerable endpoint the dashboard hits to refresh "now"). The interval loop
has a `running` re-entrancy guard, but that guard lives **only inside the
`tick()` closure** — the exported `reconcileOnce` has no lock. So a probe and a
scheduled tick (or two rapid probes) can execute the pass concurrently.

When they overlap, both passes see the same new PID as unmanaged and each
INSERTs a **distinct** row (`cc-${pid}-${randomUUID}` — a new id every pass),
because `upsertSession` conflicts on `sessions.id`, and `pid` has **no** unique
constraint. Result: duplicate active session rows for one process, duplicate
`RemoteSessionStarted` emits, and possible double-close / double-heartbeat. The
fix coalesces concurrent callers onto one in-flight pass so the scan runs once
and only one row is created per PID.

## Current state

Files and their roles:

- `apps/agent/src/services/process-watcher.ts` — owns `reconcileOnce` (the
  exported pass), the interval `tick()` loop, and the module-scope tick-state
  vars. This is the only file whose logic changes.
- `apps/agent/src/routes/sessions.ts` — `handleSessionsProbe` calls
  `reconcileOnce(db)` directly on an HTTP request. **Not modified** — it keeps
  calling the same exported symbol; the coalescing happens behind it.
- `apps/agent/src/db/sessions.ts` — `upsertSession` conflicts on `sessions.id`.
  **Not modified.**
- `packages/db/src/schema/sessions.ts` — `pid` column. **Not modified.**
- `apps/agent/src/services/process-watcher.test.ts` — the unit suite; you add
  one test here.

### The externally-triggerable probe path — `routes/sessions.ts:540-542`

```ts
export async function handleSessionsProbe(db: Db): Promise<Response> {
  try {
    const result = await reconcileOnce(db);
```

### The re-entrancy guard exists ONLY in `tick()` — `process-watcher.ts:1006-1029`

```ts
  let running = false;

  const tick = async () => {
    if (stopped) return;
    if (running) {
      // Skip overlapping tick — keep cadence honest.
      timer = setTimeout(tick, intervalMs);
      return;
    }
    running = true;
    try {
      await reconcileOnce(db);
    } catch (err) {
      log.error(
        { error: err instanceof Error ? err.message : String(err) },
        "reconcileOnce threw",
      );
    } finally {
      running = false;
      if (!stopped) {
        timer = setTimeout(tick, intervalMs);
      }
    }
  };
```

`running` is a `startProcessWatcher` closure local — a direct
`reconcileOnce(db)` call (probe, tests) does not see it, so nothing stops a
probe from running while a tick is mid-pass.

### The unguarded exported pass — `process-watcher.ts:503-513` and `847`

```ts
export async function reconcileOnce(db: Db): Promise<ReconcileResult> {
  const tickStartMs = performance.now();
  let tickErrorText: string | null = null;

  let live: LiveProcess[] = [];
  try {
    live = await listClaudeProcesses();
  } catch (err) {
    ...
```

…and the pass ends with (line 847):

```ts
  return { created, closed };
}
```

The very first `await listClaudeProcesses()` is an async yield point: a second
caller entering `reconcileOnce` here interleaves and runs its own full pass.

### Why concurrent passes duplicate rows — `process-watcher.ts:712-778`

```ts
  let created = 0;
  for (const proc of live) {
    if (managedPids.has(proc.pid)) continue;
    const sessionId = `cc-${proc.pid}-${randomUUID().slice(0, 8)}`;
    ...
      await upsertSession(db, {
        id: sessionId,
        pid: proc.pid,
        ...
      });
      created += 1;
```

Each pass mints a **fresh** `sessionId` for the same PID (`randomUUID` differs
per pass), so the two rows have different ids.

### Why the upsert can't dedup them — `db/sessions.ts:68-74`

```ts
export async function upsertSession(db: Db, session: Session): Promise<void> {
  const row = sessionToRow(session);
  await db
    .insert(sessions)
    .values(row)
    .onConflictDoUpdate({
      target: sessions.id,
```

Conflict target is `sessions.id`. Two rows with different ids never conflict.

### And `pid` has no unique constraint — `packages/db/src/schema/sessions.ts:33`

```ts
    pid: integer("pid"),
```

Plain integer, nullable, no unique index. Nothing at the DB layer stops two
active rows for the same PID.

### Module-scope tick state already lives at file level — `process-watcher.ts:464-482`

The pass already mutates module-level state (`lastReconcileMs`,
`lastReconcileError`, `lastLivePidCount`) precisely because `reconcileOnce` is
called outside the interval loop. Add the coalescing latch in the same region;
the comment at 458-463 explains why module scope (not closure scope) is correct
— one watcher per agent process, no multi-instance isolation requirement.

### `ReconcileResult` and the `__testing` export

- `reconcileOnce` returns `Promise<ReconcileResult>` where `ReconcileResult` is
  `{ created: number; closed: number }` (see line 847 `return { created, closed }`).
- The test module already imports `{ reconcileOnce, __testing }` from
  `./process-watcher` (test line 152). You do **not** need to add anything to
  `__testing` — the concurrency test drives `reconcileOnce` directly and
  asserts on DB rows.

### Repo conventions to honor

- **Runtime**: Bun. Never `tsc` for execution; `tsc --noEmit` is typecheck only.
- **Logging**: pino via `createLogger` — already imported as
  `const log = createLogger("agent:process-watcher");` (line 67). Reuse `log`;
  do not add a new logger.
- **Deliberate-simplification marker**: this repo/global convention allows a
  `// ponytail:` comment to name a known ceiling. Use it on the single global
  latch (see Step 1) — one watcher per process makes a process-wide coalesce
  correct; per-`db` keying would be speculative.

## Commands you will need

| Purpose   | Command                                             | Expected on success       |
|-----------|-----------------------------------------------------|---------------------------|
| Install   | `pnpm install`                                      | exit 0                    |
| Typecheck | `pnpm typecheck`                                    | exit 0, no errors         |
| Lint      | `pnpm lint`                                         | exit 0                    |
| Unit test | `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test process-watcher` | all pass, incl. new test |

**Test env**: the watcher DB tests live in a `describe(... requires live PG)`
block. They need `POSTGRES_URL` set to a reachable Postgres (a throwaway/local
DB — NEVER run tests against the shared homelab DB). `NEXUS_ATTACH_SECRET=test`
is required for the agent test harness generally. If `POSTGRES_URL` is unset the
block **skips cleanly** (prints `POSTGRES_URL not set — skipping`) — a skip is
NOT a pass; see STOP conditions.

## Scope

**In scope** (the only files you should modify):
- `apps/agent/src/services/process-watcher.ts`
- `apps/agent/src/services/process-watcher.test.ts`

**Out of scope** (do NOT touch, even though they look related):
- `apps/agent/src/routes/sessions.ts` — `handleSessionsProbe` keeps calling the
  same exported `reconcileOnce`; the fix is transparent to it. Do not add a lock
  here (that would only guard the probe path, not tick-vs-probe or probe-vs-probe).
- `apps/agent/src/db/sessions.ts` and `packages/db/src/schema/sessions.ts` —
  adding a `pid` unique constraint is a schema migration and a **breaking**
  data-model change (existing tables may already hold duplicate/legacy pids);
  it is explicitly NOT this plan. Coalescing at the application layer is the
  requested fix. If you conclude a DB constraint is required, STOP and report.
- The `tick()` `running` guard (lines 1006-1029) — leave it intact. It governs
  interval cadence and is complementary to the coalesce.

## Git workflow

- Branch: `advisor/002-serialize-reconcile` (create from the tip that already
  contains plan 001's merged changes).
- Commit style: conventional commits, e.g.
  `fix(agent): coalesce concurrent reconcileOnce passes to prevent duplicate session rows`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a module-scope in-flight latch and split `reconcileOnce` into a thin coalescing wrapper over the existing pass

In `apps/agent/src/services/process-watcher.ts`:

1. **Rename the existing pass.** Change the declaration at line 503 from
   `export async function reconcileOnce(db: Db): Promise<ReconcileResult> {`
   to a private `async function reconcileOncePass(db: Db): Promise<ReconcileResult> {`.
   The body (through the `return { created, closed };` at line 847) is
   unchanged. Keep the existing JSDoc but move the "Exposed standalone so the
   `POST /sessions/probe` route handler can trigger it" note to the new exported
   wrapper.

2. **Add the latch + wrapper.** Introduce a single module-scope variable near
   the other module-level tick state (around line 464-482, alongside
   `lastReconcileMs`) and an exported wrapper with the **identical** signature
   the callers already use (`(db: Db) => Promise<ReconcileResult>`). Target shape:

   ```ts
   // ponytail: one global in-flight latch — a single watcher runs per agent
   // process (see the module-scope rationale at ~L458), so a process-wide
   // coalesce is sufficient. Per-db keying would be speculative. If a second
   // caller arrives with a *different* db handle while a pass is running it
   // shares the first pass's result; in practice every caller (tick + probe)
   // uses the one agent db, so this cannot mismatch.
   let inFlightReconcile: Promise<ReconcileResult> | null = null;

   /**
    * Single reconciliation pass, serialized. Exposed standalone so the
    * `POST /sessions/probe` route handler can trigger it on demand without
    * racing the interval `tick()` (which would double-INSERT new PIDs — the
    * id is minted fresh per pass and `pid` has no unique constraint).
    *
    * Concurrent callers coalesce onto the one in-flight pass instead of
    * starting a second scan.
    */
   export function reconcileOnce(db: Db): Promise<ReconcileResult> {
     if (inFlightReconcile) return inFlightReconcile;
     const pass = reconcileOncePass(db).finally(() => {
       inFlightReconcile = null;
     });
     inFlightReconcile = pass;
     return pass;
   }
   ```

   Notes:
   - The wrapper is **not** `async` — it returns the shared promise directly so
     every coalesced caller awaits the same object and sees the same result
     (and the same rejection, if the pass throws).
   - `.finally(...)` clears the latch whether the pass resolves or rejects, so a
     failed pass does not wedge the latch permanently.
   - Do not touch `tick()` — its `await reconcileOnce(db)` now transparently
     coalesces with any concurrent probe.

**Verify**: `pnpm typecheck` → exit 0, no errors.

### Step 2: Add a concurrency regression test

In `apps/agent/src/services/process-watcher.test.ts`, inside the existing
`describe("reconcileOnce — process-watcher diff (requires live PG)", ...)` block
(the one starting at line 278 — it already has the schema/`db` setup and the
`beforeEach` that wipes the table and resets `setPgrepOutput([])`), add one test
modeled after the "Idempotent — second pass" test (lines 473-486).

The test drives **two concurrent** `reconcileOnce(db)` calls against a single
new PID and asserts the pass was coalesced — exactly one row is created and both
callers observe the same result:

```ts
test("Concurrent probe + tick coalesce — one new PID yields exactly one row", async () => {
  setPgrepOutput([pgrepLine(4242, "claude")]);

  // Fire two passes without awaiting between them — they interleave at the
  // first `await listClaudeProcesses()` yield point, reproducing the
  // probe-vs-tick race. Without coalescing each pass mints a distinct
  // `cc-4242-<uuid>` id and INSERTs its own row (no pid unique constraint),
  // producing two active rows for one process.
  const [a, b] = await Promise.all([reconcileOnce(db), reconcileOnce(db)]);

  // Coalesced: both callers share the one pass's result.
  expect(a).toEqual({ created: 1, closed: 0 });
  expect(b).toEqual(a);

  // Exactly one row for the PID — the duplicate-INSERT bug is gone.
  const rows = await db.select().from(sessions);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.pid).toBe(4242);
});
```

Why this is a valid reproduction: Bun's event loop is single-threaded, but
`Promise.all([reconcileOnce(db), reconcileOnce(db)])` starts the first call,
which suspends at `await listClaudeProcesses()`; the second call then starts and
suspends at the same point. Pre-fix, both resume and each runs the full
insert loop → two rows (`toHaveLength(1)` fails with `2`). Post-fix, the second
call returns the first's in-flight promise before running any scan → one row.

**Verify**: `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test process-watcher`
→ all tests pass, including the new
`Concurrent probe + tick coalesce` test. (Requires `POSTGRES_URL`; a
`skipping watcher integration tests` line means the DB block did not run — that
is NOT a pass, see STOP conditions.)

### Step 3: Full gate sweep

Run the three gates from the repo root.

**Verify**:
- `pnpm typecheck` → exit 0
- `pnpm lint` → exit 0
- `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test process-watcher` → all pass

## Test plan

- **New test** in `apps/agent/src/services/process-watcher.test.ts`:
  `Concurrent probe + tick coalesce — one new PID yields exactly one row`.
  Cases covered:
  - **The bug/regression**: two concurrent `reconcileOnce(db)` on one fresh PID
    produce exactly **one** row (`rows.toHaveLength(1)`), not two.
  - **Coalescing contract**: both callers resolve to the same
    `{ created: 1, closed: 0 }` result object-equal value.
- **Structural pattern to copy**: the "Idempotent — second pass" test
  (`process-watcher.test.ts:473-486`) — same `setPgrepOutput` + `pgrepLine`
  helpers, same `db.select().from(sessions)` row assertion, same enclosing
  `describe` (its `beforeAll`/`beforeEach` provide `db` + table wipe).
- **Verification**: `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test process-watcher`
  → all pass, including the 1 new test.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test process-watcher` runs
      the live-PG block (not skipped) and all tests pass, including the new
      `Concurrent probe + tick coalesce` test
- [ ] `grep -n "export async function reconcileOnce" apps/agent/src/services/process-watcher.ts`
      returns no matches (it was renamed to a private `reconcileOncePass` and
      re-exported via the non-async wrapper)
- [ ] `grep -n "export function reconcileOnce" apps/agent/src/services/process-watcher.ts`
      returns exactly one match (the coalescing wrapper)
- [ ] `apps/agent/src/routes/sessions.ts` is unmodified (`git status` shows only
      the two in-scope files changed)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows `process-watcher.ts`, `process-watcher.test.ts`, or
  `sessions.ts` changed since `64a206ff` and the "Current state" excerpts no
  longer match the live code.
- `plans/001-*.md` is not yet DONE — 001 and 002 edit the same two files; 002
  assumes 001 has landed.
- The `bun test` run prints `POSTGRES_URL not set — skipping` (or otherwise
  skips the `requires live PG` block). A skipped block is not verification —
  obtain a throwaway `POSTGRES_URL` (never the shared homelab DB) and re-run.
- The concurrency test still shows 2 rows after the fix, or a step's
  verification fails twice after a reasonable fix attempt.
- You conclude the correct fix requires a DB-level `pid` unique constraint or a
  schema migration — that is out of scope and a breaking change; report instead.
- The fix appears to require touching an out-of-scope file.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- **The latch is process-global, keyed on nothing.** It is correct because
  there is exactly one watcher and one `db` per agent process. If the agent ever
  runs multiple watchers or multiple DB targets in one process, the coalesce
  would incorrectly share a pass across them — revisit the `// ponytail:` note
  and key the latch by `db` (or move it into a per-watcher instance).
- **`tick()`'s `running` guard is retained on purpose.** It preserves interval
  cadence (skip-and-reschedule on overlap) which the coalesce does not replace.
  A reviewer should confirm both remain: the guard for cadence, the latch for
  correctness.
- **Reviewer scrutiny**: verify the wrapper returns the shared promise (not
  `await`ed inside an `async` wrapper — that would still be correct but the
  direct-return form makes the coalescing intent explicit), and that
  `.finally` clears the latch on both resolve and reject.
- **Deferred (not in this plan)**: a durable `pid` unique constraint at the DB
  layer would make duplicate rows impossible even under a future un-coalesced
  caller, but it is a breaking migration and was intentionally left out.

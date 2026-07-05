# Plan 017: Route the two held-queue floating promises through the existing safeFireAndForget wrapper

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat c67ff12c..HEAD -- apps/agent/src/routes/notifications.ts apps/agent/src/notifications/held-queue.ts apps/agent/src/notifications/held-queue.test.ts apps/agent/src/utils/safe-fire-and-forget.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (plans 017-022 touch disjoint files)
- **Category**: bug
- **Planned at**: commit `c67ff12c`, 2026-07-05

## Why this matters

The agent has a sanctioned wrapper for fire-and-forget promises —
`safeFireAndForget` in `apps/agent/src/utils/safe-fire-and-forget.ts` — used
correctly at 8 call sites (server.ts:253/267, health-scheduler.ts,
health-collector.ts, watcher-bridge.ts, db/retention.ts). There is NO
process-level `unhandledRejection` handler in product code, so the wrapper is
the only backstop. Two sites in the durable held-notification queue bypass it
with bare `void promise.then(...)`:

1. **Boot-path hydrate** (`apps/agent/src/routes/notifications.ts:158`): a
   transient Postgres outage at agent boot makes `hydrate()` reject silently.
   Held notifications never rehydrate — silently defeating the
   restart-survival guarantee the `presence_holds` table exists to provide
   (see the module docstring at `apps/agent/src/notifications/held-queue.ts:1-15`).
2. **Scheduled flush** (`apps/agent/src/notifications/held-queue.ts:150`): a
   transient PG error when a hold comes due rejects with no `.catch` and no
   log. It self-heals on the next boot (hydrate picks the row up), but the
   rejection window is invisible.

After this plan lands, both rejections are caught and logged at warn with a
named context, exactly like every other background promise in the agent. This
is a single-site convention regression fix, not a security issue.

## Current state

Files and their roles:

- `apps/agent/src/utils/safe-fire-and-forget.ts` — the sanctioned wrapper.
  REUSE IT; do not write a new helper or a bare `.catch`:

  ```ts
  // apps/agent/src/utils/safe-fire-and-forget.ts:11-18
  export function safeFireAndForget(
    promise: Promise<unknown>,
    context: string,
  ): void {
    promise.catch((err: unknown) => {
      logger.warn({ err, context }, "fire-and-forget promise rejected");
    });
  }
  ```

  Note: the wrapper already logs at **warn** — the "hydrate failure must be
  observable at warn" requirement is satisfied by routing through it. Do NOT
  add a second `.catch` or extra logging at the call sites.

- `apps/agent/src/routes/notifications.ts` — notification HTTP routes +
  singleton init. Bypass site 1 is inside `initNotificationRoutes`:

  ```ts
  // apps/agent/src/routes/notifications.ts:155-163 (inside withSingletonLock callback)
      // Rehydrate pending holds on boot: flush anything already due (coalesced
      // summary) and schedule the rest. Survives agent restart — the data-loss
      // bug the in-memory buffer had.
      void heldQueue.hydrate().then((flushedNow) => {
        if (flushedNow.length > 0 && manager) {
          void manager.flushHeldBatch(flushedNow);
        }
      });
    });
  }
  ```

  `initNotificationRoutes(db)` is itself dispatched via
  `safeFireAndForget(initNotificationRoutes(db), "init-notification-routes")`
  at `apps/agent/src/server.ts:253` — but the `void ...then()` detaches the
  hydrate promise from that wrapper, so its rejection is unhandled.

- `apps/agent/src/notifications/held-queue.ts` — durable held queue backed by
  the `presence_holds` table. Bypass site 2 is inside `scheduleFlush`:

  ```ts
  // apps/agent/src/notifications/held-queue.ts:146-153
    scheduleFlush(id: string, holdUntil: Date, onFlush?: (row: PresenceHold) => void): void {
      this.clearTimer(id);
      const delay = Math.max(0, holdUntil.getTime() - Date.now());
      const timer = setTimeout(() => {
        void this.flush(id).then((row) => {
          if (row && onFlush) onFlush(row);
        });
      }, delay);
  ```

  `flush()` (line 97) awaits `this.db.update(...).returning()` with no
  internal try/catch — it rejects on any transient PG error.

- `apps/agent/src/notifications/held-queue.test.ts` — existing test file to
  extend. Its single `describe` is PG-gated
  (`describe.skipIf(!hasPg)("HeldQueue (requires live PG)", ...)` at line 44)
  and skips entirely when `POSTGRES_URL` is unset. The new rejection-path
  test must NOT be PG-gated (it uses a stub db), so it goes in a NEW
  top-level `describe` block in the same file.

- `apps/agent/src/utils/safe-fire-and-forget.test.ts` — exemplar for the
  no-unhandled-rejection assertion pattern (lines 53-67): register a
  `process.on("unhandledRejection")` listener, wait ~50 ms, remove the
  listener, assert the flag stayed false.

Repo conventions that apply:

- Bun monorepo — run tests with `bun test`, never `tsc` for execution.
- Import style for the wrapper (from `apps/agent/src/db/retention.ts:12`):
  `import { safeFireAndForget } from "../utils/safe-fire-and-forget";`
  (both in-scope source files sit one directory below `src/`, so `../utils/`
  is correct for both).
- Bun `mock.module` is process-global and irreversible — do NOT add any
  `mock.module` call to `held-queue.test.ts` (its own header comment at
  lines 36-42 documents why). The stub-db-object approach below needs none.
- Commit pattern: single commit, targeted adds only:
  `git add <files> .beads/ && git commit && git push`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install (only if node_modules missing) | `pnpm install` | exit 0 |
| Held-queue suite | `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/notifications/held-queue.test.ts` | 0 fail (PG tests skip without `POSTGRES_URL`; the new stub-db tests run and pass) |
| Route + wrapper suites | `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/routes/notifications-telegram.test.ts src/utils/safe-fire-and-forget.test.ts` | 0 fail (baseline verified 2026-07-05: 5 pass) |
| Notifications suites | `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/notifications src/routes` | 0 fail |
| Typecheck | `pnpm typecheck` (repo root) | exit 0, no NEW errors attributable to changed files |
| Lint | `pnpm lint` (repo root) | exit 0, no NEW errors attributable to changed files |

(Baseline was greened 2026-07-03; if the baseline drifted red again, only new
errors in the three changed files are yours.)

## Scope

**In scope** (the only files you should modify):

- `apps/agent/src/routes/notifications.ts` (wrap hydrate + inner flushHeldBatch)
- `apps/agent/src/notifications/held-queue.ts` (wrap scheduled flush)
- `apps/agent/src/notifications/held-queue.test.ts` (add rejection-path test)
- `plans/README.md` (status row only, if the index exists and you maintain it)

**Out of scope** (do NOT touch, even though they look related):

- `apps/agent/src/db/health.ts:30` — `.then` there is part of a
  `queryPromise` awaited inside try + `Promise.race`; NOT a floating promise.
- `apps/agent/src/terminal/tmux-pty-source.ts:383/:506` — `.exited` has no
  real reject path. Do not touch.
- `apps/web/src/lib/agent-ws-client.ts:310` — defensive Blob branch,
  `binaryType=arraybuffer`. Do not touch.
- `apps/agent/src/utils/safe-fire-and-forget.ts` — reuse as-is; no changes.
- Any process-level `unhandledRejection` handler — that design decision has
  NOT been made; do not add one.
- Splitting or refactoring `routes/notifications.ts` — the god-module split
  is deferred by the maintainer.
- All other `void`-promise sites in the repo — other plans own other files;
  this plan is exactly these two sites.

## Git workflow

- Work on the current branch (no branch creation).
- Single commit at the end; message style from `git log` (conventional-ish
  prefix), e.g.:
  `fix(agent): route held-queue floating promises through safeFireAndForget`
- Stage only: `git add apps/agent/src/routes/notifications.ts apps/agent/src/notifications/held-queue.ts apps/agent/src/notifications/held-queue.test.ts .beads/`
  (plus `plans/README.md` if you updated it). Never `git add .` or `-A`.
- Push after commit — work is not done until push succeeds.

## Steps

### Step 1: Wrap the scheduled flush in held-queue.ts

In `apps/agent/src/notifications/held-queue.ts`:

1. Add the import below the existing imports (after line 22,
   `import { lifecycleBus } from "../services/lifecycle-bus";`):

   ```ts
   import { safeFireAndForget } from "../utils/safe-fire-and-forget";
   ```

2. In `scheduleFlush` (line 146), replace the timer body

   ```ts
   const timer = setTimeout(() => {
     void this.flush(id).then((row) => {
       if (row && onFlush) onFlush(row);
     });
   }, delay);
   ```

   with:

   ```ts
   const timer = setTimeout(() => {
     safeFireAndForget(
       this.flush(id).then((row) => {
         if (row && onFlush) onFlush(row);
       }),
       "held-queue-scheduled-flush",
     );
   }, delay);
   ```

   Change nothing else in the method (the `unref` block and
   `this.timers.set(id, timer)` stay as-is).

**Verify**: `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/notifications/held-queue.test.ts` → 0 fail (PG suite skips without POSTGRES_URL).

### Step 2: Wrap the boot hydrate in routes/notifications.ts

In `apps/agent/src/routes/notifications.ts`:

1. Add the import next to the other relative imports (e.g. after line 14,
   `import { HeldQueue } from "../notifications/held-queue";`):

   ```ts
   import { safeFireAndForget } from "../utils/safe-fire-and-forget";
   ```

2. Inside `initNotificationRoutes`, replace lines 158-162

   ```ts
   void heldQueue.hydrate().then((flushedNow) => {
     if (flushedNow.length > 0 && manager) {
       void manager.flushHeldBatch(flushedNow);
     }
   });
   ```

   with:

   ```ts
   safeFireAndForget(
     heldQueue.hydrate().then((flushedNow) => {
       if (flushedNow.length > 0 && manager) {
         safeFireAndForget(
           manager.flushHeldBatch(flushedNow),
           "held-queue-flush-batch",
         );
       }
     }),
     "held-queue-hydrate",
   );
   ```

   Keep the three-line comment above it (lines 155-157) unchanged. The two
   distinct contexts (`held-queue-hydrate` vs `held-queue-flush-batch`) are
   deliberate — a boot-time PG hiccup and a batch-dispatch failure are
   different incidents in the logs.

**Verify**: `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/routes/notifications-telegram.test.ts` → 2 pass, 0 fail (this suite boots `initNotificationRoutes` with a fake db and exercises the changed code path).

### Step 3: Add the rejection-path regression test

In `apps/agent/src/notifications/held-queue.test.ts`, add a NEW top-level
`describe` block after the existing PG-gated one (after line 161). It must
NOT be inside `describe.skipIf(!hasPg)` and must NOT use `mock.module`. Model
the unhandled-rejection listener on
`apps/agent/src/utils/safe-fire-and-forget.test.ts:53-67`:

```ts
describe("HeldQueue scheduled-flush rejection (no PG needed)", () => {
  it("routes a rejecting flush through safeFireAndForget (no unhandledRejection)", async () => {
    // Stub db whose update chain rejects — mimics a transient PG outage at
    // the moment a hold comes due (held-queue.ts flush()).
    const rejectingDb = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => Promise.reject(new Error("pg down")),
          }),
        }),
      }),
    } as unknown as Db;

    let unhandled = false;
    const handler = () => {
      unhandled = true;
    };
    process.on("unhandledRejection", handler);

    const q = new HeldQueue(rejectingDb, "leo");
    // Past-due holdUntil → timer fires immediately (delay clamps to 0).
    q.scheduleFlush("reject-1", new Date(Date.now() - 1_000));

    // Wait long enough for the timer + rejection to settle.
    await new Promise((r) => setTimeout(r, 50));

    process.removeListener("unhandledRejection", handler);
    q.shutdown();
    expect(unhandled).toBe(false);
  });
});
```

Notes for the executor:

- `Db` and `HeldQueue` are already imported at the top of this test file
  (lines 12-13) — no new imports needed.
- Before Step 1's change this test FAILS (the bare `void ...then()` produces
  an unhandled rejection); after it, it passes. If you want to see it fail
  first, stash Step 1, run it, unstash.
- The warn-log content (`{ err, context }`, message
  `"fire-and-forget promise rejected"`) is already asserted at the wrapper
  level in `safe-fire-and-forget.test.ts:36-51` — do not duplicate that
  assertion here; doing so would require a `mock.module` on
  `@nexus/core/node`, which this file must not add (see its lines 36-42).

**Verify**: `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/notifications/held-queue.test.ts` → 1 pass minimum (the new test), 0 fail.

### Step 4: Full gate

**Verify**:

1. `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/notifications src/routes src/utils` → 0 fail.
2. `pnpm typecheck` (repo root) → exit 0 (or no NEW errors in the three changed files if baseline drifted).
3. `pnpm lint` (repo root) → same standard.
4. `git status --short` → only the in-scope files modified.

## Test plan

- New test: `apps/agent/src/notifications/held-queue.test.ts`, one case —
  scheduled flush whose DB update rejects produces NO unhandledRejection
  (the exact regression these two sites had). Structural pattern:
  `apps/agent/src/utils/safe-fire-and-forget.test.ts:53-67` for the listener,
  `apps/agent/src/routes/notifications-telegram.test.ts:45-87` for the
  stub-db-object idiom (chained builder returning a rejecting terminal).
- Existing coverage relied on (must stay green, no edits):
  - `safe-fire-and-forget.test.ts` — wrapper logs warn with context on
    rejection.
  - `notifications-telegram.test.ts` — boots `initNotificationRoutes` with a
    fake db, exercising the Step 2 hydrate path happy case.
  - PG-gated `held-queue.test.ts` suite — unchanged behavior of
    hold/flush/hydrate when the DB works (runs only with `POSTGRES_URL`).
- Verification: `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/notifications/held-queue.test.ts src/routes/notifications-telegram.test.ts src/utils/safe-fire-and-forget.test.ts` → all pass, including 1 new test.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "void heldQueue.hydrate" apps/agent/src/routes/notifications.ts` → no matches
- [ ] `grep -n "void manager.flushHeldBatch" apps/agent/src/routes/notifications.ts` → no matches
- [ ] `grep -n "void this.flush" apps/agent/src/notifications/held-queue.ts` → no matches
- [ ] `grep -c "safeFireAndForget" apps/agent/src/routes/notifications.ts` → `3` (1 import + 2 calls)
- [ ] `grep -c "safeFireAndForget" apps/agent/src/notifications/held-queue.ts` → `2` (1 import + 1 call)
- [ ] `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/notifications src/routes src/utils` → 0 fail
- [ ] `pnpm typecheck` → no NEW errors in the three changed files
- [ ] `git status --short` shows only in-scope files (plus `.beads/` bookkeeping)
- [ ] `plans/README.md` status row updated (if index exists and you maintain it)

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code (drift since
  `c67ff12c`) — especially if the `void heldQueue.hydrate()` block or the
  `scheduleFlush` timer body has already been rewritten.
- The new rejection test still reports `unhandled === true` after Step 1 is
  in place (would mean the promise is escaping the wrapper some other way —
  investigate, do not paper over with a bare `.catch`).
- Any PREVIOUSLY-PASSING test in `src/notifications` or `src/routes` fails
  after your change and a single fix attempt.
- You find yourself wanting to edit `safe-fire-and-forget.ts`, add a
  process-level `unhandledRejection` handler, or touch any file on the
  out-of-scope list.

## Maintenance notes

- Reviewer focus: confirm the two `safeFireAndForget` contexts read
  distinctly in logs (`held-queue-hydrate`, `held-queue-flush-batch`,
  `held-queue-scheduled-flush`) and that no extra `.catch` was layered on
  top of the wrapper.
- If a route-level test that forces `hydrate()` to reject is ever wanted
  (asserting the warn via the shared `loggerSpy`), the home for it is a
  routes test using `installCoreNodeMock()` from
  `apps/agent/src/testing/mock-core-node.ts` + a rejecting fake db, modeled
  on `notifications-telegram.test.ts`. Deferred here: the wrapper's warn
  behavior is already unit-tested, and adding `mock.module` machinery for a
  duplicate assertion is not worth the sibling-suite risk.
- If the deferred notifications-router split ever lands, the hydrate block
  moves with `initNotificationRoutes` — keep the wrapper and contexts intact.
- Future `HeldQueue` methods launched from timers or boot paths must go
  through `safeFireAndForget`; there is still no process-level rejection
  backstop by design.

# Plan 009: Abort the credential watchers on shutdown

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` if that file exists (skip if it does not).
>
> **Drift check (run first)**:
> `git diff --stat 64a206ff..HEAD -- apps/agent/src/server.ts apps/agent/src/credentials/credential-watcher.ts apps/agent/src/credentials/active-credential-watcher.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `64a206ff`, 2026-07-03

## Why this matters

`startServer()` starts two filesystem watchers — one over the credential pool
directory, one over Claude Code's live `~/.claude/.credentials.json` — and
**discards the `AbortController` each returns**. Nothing ever calls `.abort()`,
so the underlying `fs.watch(...)` iterators and their 200ms debounce timers keep
the event loop and file descriptors alive after `server.stop()` returns. In the
normal daemon path this is masked by `process.exit(0)`, but in embedded /
in-process-restart / test scenarios (the exact class the `processWatcher.stop()`
teardown was added to fix — see `server.ts:306-327`) it is a watcher/fd leak:
the server "stops" but background handles linger. This plan captures both
`AbortController`s and aborts them on the same shutdown path as the existing
process-watcher teardown.

## Current state

Files involved:

- `apps/agent/src/server.ts` — the agent entry point. `startServer()` starts the
  watchers (call sites below) and builds a `NexusServer` wrapper whose `stop()`
  already tears down the process watcher. This is the ONLY file that needs a
  production change.
- `apps/agent/src/credentials/credential-watcher.ts` — defines
  `startCredentialWatcher(pool): AbortController` (line 200). Its `ac.signal`
  drives `watch(credDir, { signal: ac.signal })` (line 264) and a `pending`
  debounce map of `setTimeout` handles (lines 208, 275-289). No `.abort()` ⇒
  the `for await (const event of watcher)` loop (line 267) never resolves and
  the timers keep firing.
- `apps/agent/src/credentials/active-credential-watcher.ts` — defines
  `startActiveCredentialWatcher(pool): AbortController` (line 244), same shape:
  `watch(CC_CREDENTIALS_PATH, { signal: ac.signal })` (line 296) plus a
  `debounceTimer` (lines 248, 261-272, cleared in the `finally` at 309-311 that
  only runs once the loop resolves — i.e. only after `.abort()`).

The discard, verbatim (`apps/agent/src/server.ts:263-277`):

```ts
    const pool = getCredentialPool();
    if (pool) {
      safeFireAndForget(pool.refreshMetadata(), "credential-metadata-refresh");
      // Watch credential directory for new/changed files
      startCredentialWatcher(pool);
      // Watch ~/.claude/.credentials.json symlink for active-account tracking
      startActiveCredentialWatcher(pool);
    }

    // Process watcher: 30s reconcile loop ...
    processWatcher = startProcessWatcher(db);
  }
```

The existing teardown exemplar to mirror (`apps/agent/src/server.ts:243-244` and
`306-327`):

```ts
  // Track DB-backed background subsystems so graceful shutdown can stop them.
  let processWatcher: ProcessWatcherHandle | null = null;
  ...
  const wrapper: NexusServer = processWatcher
    ? {
        get port() {
          return baseWrapper.port;
        },
        stop(closeActiveConnections?: boolean) {
          try {
            processWatcher?.stop();
          } catch (err) {
            logger.warn(
              { error: err instanceof Error ? err.message : String(err) },
              "process-watcher stop threw — continuing shutdown",
            );
          }
          baseWrapper.stop(closeActiveConnections);
        },
      }
    : baseWrapper;
```

Conventions this change must honor:
- `AbortController` is the established "stop a watcher" handle in this codebase
  (both watcher modules already return one and check `err.name === "AbortError"`).
  Do NOT invent a new stop mechanism — call `.abort()`.
- Teardown steps warn-and-continue: each disposer is wrapped so one throwing
  does not abort the rest of shutdown (see the `try/catch` around
  `processWatcher?.stop()` above). Match that.
- `logger` is already imported in `server.ts` (line 27:
  `import { logger, parseConfig, getAgentsConfigPath } from "@nexus/core/node";`).

## Commands you will need

| Purpose        | Command                                                                 | Expected on success            |
|----------------|-------------------------------------------------------------------------|--------------------------------|
| Install        | `pnpm install`                                                          | exit 0                         |
| Typecheck      | `pnpm typecheck`                                                        | exit 0, no errors              |
| Run this test  | `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test server-credential-watcher-teardown` | all pass, incl. the new test   |
| Focused watcher tests (regression) | `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test credential-watcher` | all pass |

Notes:
- `NEXUS_ATTACH_SECRET=test` is required for the agent's `bun test` suite.
- The new test does NOT need Postgres — it stubs the DB-touching modules (see
  Test plan). Do not set `POSTGRES_URL`.

## Scope

**In scope** (the only files you should modify):
- `apps/agent/src/server.ts` — capture the two `AbortController`s and abort them
  in the wrapper `stop()`.
- `apps/agent/src/server-credential-watcher-teardown.test.ts` (create) — the
  regression test.

**Out of scope** (do NOT touch, even though they look related):
- `apps/agent/src/credentials/credential-watcher.ts` and
  `active-credential-watcher.ts` — they already return a correct
  `AbortController`; the bug is purely that `server.ts` discards it. Changing
  them is unnecessary and risks the many existing watcher tests.
- The `processWatcher` teardown behaviour — leave it working exactly as-is;
  only extend the same wrapper.
- Any change to the `NexusServer` public interface (`port` / `stop`) — callers
  across the codebase and tests depend on its current shape.

## Git workflow

- Branch: `advisor/009-stop-credential-watchers`
- Commit the source fix and the test together; conventional-commit message,
  matching repo style (e.g. `git log` shows `feat(spec): ...`, `feat(agent): ...`).
  Use: `fix(agent): abort credential watchers on server stop`
- Do NOT push or open a PR.

## Steps

### Step 1: Capture the two AbortControllers at their call sites

In `apps/agent/src/server.ts`, next to the existing
`let processWatcher: ProcessWatcherHandle | null = null;` declaration
(line 244), add two nullable handles:

```ts
  let processWatcher: ProcessWatcherHandle | null = null;
  let credWatcher: AbortController | null = null;
  let activeCredWatcher: AbortController | null = null;
```

Then in the `if (pool) { ... }` block (currently lines 264-270), assign the
return values instead of discarding them:

```ts
    if (pool) {
      safeFireAndForget(pool.refreshMetadata(), "credential-metadata-refresh");
      // Watch credential directory for new/changed files
      credWatcher = startCredentialWatcher(pool);
      // Watch ~/.claude/.credentials.json symlink for active-account tracking
      activeCredWatcher = startActiveCredentialWatcher(pool);
    }
```

`AbortController` is a global (no import needed).

**Verify**: `pnpm typecheck` → exit 0, no errors.

### Step 2: Abort them in the wrapper `stop()`

Extend the existing shutdown wrapper (currently lines 310-327) so the teardown
condition fires when ANY background subsystem was started, and so `stop()`
disposes all three with the same warn-and-continue discipline as the current
`processWatcher?.stop()`. Replace the `const wrapper: NexusServer = processWatcher ? {...} : baseWrapper;`
block with:

```ts
  // Wrap the base wrapper so graceful shutdown tears down every DB-backed
  // background subsystem (process watcher + both credential fs watchers).
  // Without this the watch loops and debounce timers keep the event loop
  // open after the server stops, holding fds during dev restarts / tests.
  const hasBackground = processWatcher || credWatcher || activeCredWatcher;
  const wrapper: NexusServer = hasBackground
    ? {
        get port() {
          return baseWrapper.port;
        },
        stop(closeActiveConnections?: boolean) {
          const disposers: Array<[string, () => void]> = [
            ["process-watcher", () => processWatcher?.stop()],
            ["credential-watcher", () => credWatcher?.abort()],
            ["active-credential-watcher", () => activeCredWatcher?.abort()],
          ];
          for (const [name, dispose] of disposers) {
            try {
              dispose();
            } catch (err) {
              logger.warn(
                { subsystem: name, error: err instanceof Error ? err.message : String(err) },
                "background subsystem stop threw — continuing shutdown",
              );
            }
          }
          baseWrapper.stop(closeActiveConnections);
        },
      }
    : baseWrapper;
```

This preserves the existing behaviour (process watcher still stops first) and
adds the two `.abort()` calls on the same path.

**Verify**: `pnpm typecheck` → exit 0, no errors.

### Step 3: Write the regression test

Create `apps/agent/src/server-credential-watcher-teardown.test.ts`. The test
proves that `server.stop()` aborts BOTH credential-watcher `AbortController`s.
It avoids Postgres by stubbing every DB-touching module `startServer` calls, and
replaces the two watcher functions with fakes that return a real
`AbortController` the test can inspect.

Model the mock-before-dynamic-import ordering on `apps/agent/src/server-bind.test.ts`
(top-of-file comment there explains why `./server` must be imported via
top-level-await AFTER the mocks — otherwise a static import hoists above them).

Use `mock.module` (already used across the suite, e.g. `server-bind.test.ts`,
`health-collector.test.ts`). Stub exactly these modules, then import `./server`:

- `./routes/notifications` → `initNotificationRoutes: async () => {}`
- `./routes/credentials` → `initCredentialRoutes: () => {}`,
  `getCredentialPool: () => ({ refreshMetadata: async () => 0 })` (truthy pool so
  the `if (pool)` branch runs)
- `./notifications/router` → `setTtsDbHandle: () => {}`
- `./services/process-watcher` → `startProcessWatcher: () => ({ stop: () => {} })`
- `./credentials/credential-watcher` → fakes for BOTH exports that push their
  returned `AbortController` into a shared array:
  ```ts
  const startedControllers: AbortController[] = [];
  // inside mock.module factory:
  startCredentialWatcher: () => { const ac = new AbortController(); startedControllers.push(ac); return ac; },
  startActiveCredentialWatcher: () => { const ac = new AbortController(); startedControllers.push(ac); return ac; },
  ```
  (Both are imported from `./credentials/credential-watcher` in `server.ts` — one
  mock covers both.)

Force the deterministic single-loopback bind (no `tailscale` shell-out) the same
way `homelab-transport.test.ts:95-106` does: create a tmp dir, write
`bind_address = "127.0.0.1"\n` into `agents.toml`, and set
`process.env.NEXUS_CONFIG_DIR` to it in `beforeAll`; restore + `rmSync` in
`afterAll`.

Test body:

```ts
const db = {} as unknown as import("@nexus/db").Db; // stubbed modules never touch it
const server = startServer(0, db);
expect(startedControllers.length).toBe(2);
expect(startedControllers.every((ac) => ac.signal.aborted)).toBe(false);

server.stop(true);

expect(startedControllers.length).toBe(2);
expect(startedControllers.every((ac) => ac.signal.aborted)).toBe(true);
```

**Verify**: `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test server-credential-watcher-teardown`
→ the new test passes.

### Step 4: Confirm no regression in the existing watcher tests

**Verify**: `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test credential-watcher`
→ all existing `credential-watcher` / `active-credential-watcher` tests still pass.

## Test plan

- New test file `apps/agent/src/server-credential-watcher-teardown.test.ts`
  covering:
  - **Happy/regression path**: after `startServer(0, db)`, exactly two
    `AbortController`s are created and NOT aborted; after `server.stop(true)`,
    BOTH are `signal.aborted === true`. This directly fails on the current code
    (which discards the controllers, so nothing aborts them).
- Structural pattern to copy:
  - `mock.module` + post-mock dynamic import of `./server`:
    `apps/agent/src/server-bind.test.ts` (lines 20-33).
  - `NEXUS_CONFIG_DIR` + `bind_address = "127.0.0.1"` deterministic bind and
    `server.stop(true)` teardown: `apps/agent/src/testing/homelab-transport.test.ts`
    (lines 95-117).
- Verification: `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test server-credential-watcher-teardown`
  → all pass, including the 1 new test.

If the `mock.module` surface proves brittle in your environment (e.g. an
unstubbed module still reaches for Postgres), STOP per the STOP conditions and
report — do NOT weaken the assertion into a source-only check. A source-reading
"looks aborted" claim is not acceptable evidence; the pasted passing `bun test`
output for the new test is the required proof.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test server-credential-watcher-teardown` passes, and the new test asserting both controllers are aborted after `stop()` exists
- [ ] `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test credential-watcher` passes (no regression)
- [ ] `grep -n "startCredentialWatcher(pool)" apps/agent/src/server.ts` shows the return value assigned (`credWatcher = startCredentialWatcher(pool)`), not a bare call
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated (only if that file exists)

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `apps/agent/src/server.ts:263-277` or `306-327` does not match the
  excerpts in "Current state" (the file drifted since this plan was written).
- Either watcher module no longer returns an `AbortController` from its
  `start*` function (the drift check on `credential-watcher.ts` /
  `active-credential-watcher.ts` shows changes to lines ~200 / ~244).
- The new test cannot be made to pass without touching a real Postgres instance
  (i.e. a stubbed module still reaches the DB) — report which module leaked
  through rather than adding `POSTGRES_URL` or deleting the assertion.
- `pnpm typecheck` fails twice after a reasonable fix attempt.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- If a THIRD DB-backed background subsystem is added in `startServer` (like a new
  watcher), add it to the `disposers` array in the wrapper `stop()` and to
  `hasBackground` — the wrapper is the single teardown seam for all of them.
- A reviewer should scrutinise that `credWatcher`/`activeCredWatcher` are only
  assigned inside the `if (pool)` block (they stay `null` when no pool exists,
  and `.abort()` is null-guarded via optional chaining), and that
  `baseWrapper.stop()` is still called LAST so the HTTP servers close after the
  background subsystems.
- Deferred out of this plan: no change to the watchers themselves. Their
  `AbortError` handling already logs `"credential watcher stopped"` /
  `"active credential watcher stopped"` on abort — that log line appearing at
  shutdown is the runtime confirmation the abort propagated.

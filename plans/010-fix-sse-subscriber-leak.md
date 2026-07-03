# Plan 010: Self-clean the SSE lifecycle-bus subscription when `enqueue` fails, not only in `cancel()`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 64a206ff..HEAD -- apps/agent/src/routes/events-sse.ts apps/agent/src/services/lifecycle-bus.ts`
> If either in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `64a206ff`, 2026-07-03

## Why this matters

The agent is a long-lived daemon. Dashboard and menu-bar clients open and drop
`/events/stream` SSE connections continuously. Each open subscribes a wildcard
handler (`busHandler`) to the global `lifecycleBus`; that handler is unsubscribed
**only** inside the stream's `cancel()` callback. If a stream tears down without
`cancel()` firing (an abnormal close where the runtime closes the controller but
does not invoke the cancel callback), the handler stays registered forever. Every
subsequent bus event then invokes a dead handler whose `controller.enqueue`
throws — the throw is silently swallowed, the handler never removes itself, and
the closed controller stays reachable (a memory leak). Accumulated leaked handlers
also trip `EventEmitter`'s `setMaxListeners(50)` warning. After this lands, a bus
handler removes itself the first time its `enqueue` fails, so a leaked subscriber
cannot outlive its stream regardless of whether `cancel()` fires.

> **Confidence note (MED)**: The uncertainty is *only* about how reliably Bun's
> web-streams implementation calls `cancel()` on every disconnect. The
> self-cleanup added here is correct and harmless *regardless* of that answer —
> if `cancel()` always fires, the new catch path is simply never taken; if it
> sometimes does not, the catch path closes the leak. The two cleanup paths are
> made idempotent so running both is safe.

## Current state

Files:

- `apps/agent/src/routes/events-sse.ts` — the `/events/stream` SSE handler
  (`handleEventsStream`, lines 93–154). Subscribes `busHandler` to the bus in
  `start()`; unsubscribes **only** in `cancel()`.
- `apps/agent/src/services/lifecycle-bus.ts` — the `LifecycleBus` class
  (`onAny`/`offAny` lines 375–382, `setMaxListeners(50)` line 350). Exposes a
  private `EventEmitter`; the only test-observability affordances today are the
  `currentSeq` getter (line 408) and `removeAllListeners()` (line 413).
- `apps/agent/src/server-request-handler.ts:719-720` — routes
  `GET /events/stream` to `handleEventsStream()`. (Read-only reference; do not
  change.)

The bug — `apps/agent/src/routes/events-sse.ts:93-144` as it exists today:

```ts
export function handleEventsStream(): Response {
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let busHandler: ((envelope: LifecycleEnvelope) => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(": keepalive\n\n"));
      const connectEvent = JSON.stringify({
        type: "connected",
        timestamp: new Date().toISOString(),
      });
      controller.enqueue(encoder.encode(`data: ${connectEvent}\n\n`));

      keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          if (keepalive) clearInterval(keepalive);
        }
      }, 30_000);

      busHandler = (envelope: LifecycleEnvelope) => {
        try {
          const data = JSON.stringify(envelope);
          controller.enqueue(encoder.encode(`event: ${envelope.event}\ndata: ${data}\n\n`));
        } catch {
          // Stream closed — will be cleaned up in cancel()
        }
      };
      lifecycleBus.onAny(busHandler);
    },
    cancel() {
      // Client disconnected — cleanup subscriptions.
      if (keepalive) clearInterval(keepalive);
      if (busHandler) lifecycleBus.offAny(busHandler);
      log.debug("SSE client disconnected");
    },
  });

  return new Response(stream, { /* headers ... */ });
}
```

The two defects:

1. **`busHandler` catch swallows the error and does NOT unsubscribe** (lines
   132–134). The comment even says "will be cleaned up in cancel()" — which is
   exactly the assumption that fails when `cancel()` never fires.
2. **`keepalive`'s own catch clears its interval but does not unsubscribe
   `busHandler`** (lines 115–117), and cleanup lives only in `cancel()`
   (lines 138–143).

Relevant bus API — `apps/agent/src/services/lifecycle-bus.ts`:

```ts
constructor() {
  this.emitter.setMaxListeners(50);   // line 350 — leaked handlers trip this
}
onAny(handler: (envelope: LifecycleEnvelope) => void): void {
  this.emitter.on("*", handler);      // lines 375-377
}
offAny(handler: (envelope: LifecycleEnvelope) => void): void {
  this.emitter.off("*", handler);     // lines 380-382
}
get currentSeq(): number {            // lines 408-410 — existing test affordance
  return this.seq;
}
```

Repo conventions this plan honors:

- Runtime is **Bun**; tests use `bun:test` (`import { describe, expect, it } from "bun:test"`).
- SSE tests connect over HTTP against a shared in-process server started by
  `apps/agent/src/server.helpers.ts` (`export const baseUrl = ...`,
  `export const server = startServer(0)`). The server and the tests share the
  **same** `lifecycleBus` singleton, so a test can read the bus's listener count
  directly while driving the endpoint over HTTP. Model the new test structurally
  after `apps/agent/src/server-sse-idle.test.ts` (imports `baseUrl` from
  `./server.helpers`, opens `/events/stream`, reads the initial frame with a
  `getReader()`).
- Test-observability getters on the bus follow the existing `currentSeq` /
  `removeAllListeners()` "for testing" pattern — add the new one in the same
  style and location.

## Commands you will need

| Purpose        | Command                                                         | Expected on success       |
|----------------|----------------------------------------------------------------|---------------------------|
| Typecheck      | `pnpm typecheck`                                                | exit 0, no errors         |
| Run new test   | `cd apps/agent && bun test src/events-sse-leak.test.ts`        | all pass (2 tests)        |
| Run SSE suite  | `cd apps/agent && bun test sse`                                | all pass (no regressions) |

(Verify `pnpm typecheck` from the repo root `/home/nyaptor/dev/nx`. `bun test`
runs from `apps/agent`.)

## Scope

**In scope** (the only files you should modify):

- `apps/agent/src/routes/events-sse.ts` — add self-cleanup + idempotency guard.
- `apps/agent/src/services/lifecycle-bus.ts` — add ONE test-observability getter
  (`wildcardListenerCount`).
- `apps/agent/src/events-sse-leak.test.ts` (create) — the regression test.
- `plans/README.md` — status row update (only if the file exists; the executor
  instructions cover the case where a reviewer owns the index).

**Out of scope** (do NOT touch, even though they look related):

- `apps/agent/src/server-sse-idle.test.ts` — a separate regression (nx-4p8n,
  idle timeout). Do not modify; only read it as a structural model.
- `apps/agent/src/server-request-handler.ts` and `server.ts` — routing/wiring is
  correct; the fix is entirely inside the handler and the bus.
- `handleGetEvents` (the JSON query endpoint, `events-sse.ts:31-81`) — unrelated.
- The `specs/events` SSE stream, if present elsewhere — different handler, not
  this finding.
- The wire/frame format of SSE output (`event:`/`data:` framing) — do not change
  what clients receive; only change teardown behavior.

## Git workflow

- Branch: `advisor/010-fix-sse-leak` (create it before the first edit:
  `git checkout -b advisor/010-fix-sse-leak`).
- Commit as one logical unit; conventional-commits style, e.g.
  `fix(agent): self-clean SSE bus handler on enqueue failure, not only in cancel()`.
- Do NOT push or open a PR.

## Steps

### Step 1: Add a `wildcardListenerCount` test-observability getter to the bus

In `apps/agent/src/services/lifecycle-bus.ts`, add a getter next to the existing
`currentSeq` getter (around line 408), mirroring its "for testing" style:

```ts
  /** Number of wildcard (`onAny`) listeners — for testing leak cleanup. */
  get wildcardListenerCount(): number {
    return this.emitter.listenerCount("*");
  }
```

Do not change anything else in this file.

**Verify**: `pnpm typecheck` → exit 0, no errors.

### Step 2: Make the SSE handler self-clean on `enqueue` failure, idempotently

In `apps/agent/src/routes/events-sse.ts`, inside `handleEventsStream`:

1. Add a single shared `closed` flag and one cleanup function that is safe to
   call more than once. Declare them alongside the existing `keepalive` /
   `busHandler` locals (top of `handleEventsStream`, ~lines 94–95):

   ```ts
   let closed = false;
   const cleanup = () => {
     if (closed) return;
     closed = true;
     if (keepalive) clearInterval(keepalive);
     if (busHandler) lifecycleBus.offAny(busHandler);
   };
   ```

2. In the `busHandler` catch (currently lines 132–134, the block that only holds
   the "will be cleaned up in cancel()" comment), call `cleanup()`:

   ```ts
   busHandler = (envelope: LifecycleEnvelope) => {
     try {
       const data = JSON.stringify(envelope);
       controller.enqueue(encoder.encode(`event: ${envelope.event}\ndata: ${data}\n\n`));
     } catch {
       // Stream closed abnormally without cancel() — self-clean so we do not
       // leak a dead subscriber on the global bus.
       cleanup();
     }
   };
   ```

3. In the `keepalive` interval's catch (currently lines 115–117), replace the
   inline `if (keepalive) clearInterval(keepalive);` with `cleanup();` so a
   keepalive-time failure also unsubscribes the handler:

   ```ts
   keepalive = setInterval(() => {
     try {
       controller.enqueue(encoder.encode(": keepalive\n\n"));
     } catch {
       cleanup();
     }
   }, 30_000);
   ```

4. In `cancel()` (currently lines 138–143), delegate to the same `cleanup()` so
   the normal-disconnect path stays idempotent with the self-clean path:

   ```ts
   cancel() {
     cleanup();
     log.debug("SSE client disconnected");
   },
   ```

Keep everything else (initial frames, headers, subscription via
`lifecycleBus.onAny(busHandler)`) exactly as it is.

**Verify**: `pnpm typecheck` → exit 0, no errors.

### Step 3: Write the regression test

Create `apps/agent/src/events-sse-leak.test.ts`. Model the imports and the
open-and-read-first-frame shape after `apps/agent/src/server-sse-idle.test.ts`.
The test asserts the invariant that matters: **after a stream is opened and then
torn down, the bus wildcard listener count returns to its baseline** — no leaked
subscriber — whether cleanup happened via `cancel()` or via the self-clean catch.

Two cases:

1. **Normal disconnect returns to baseline.** Open `/events/stream`, read the
   first frame (guarantees `start()` ran and the handler is subscribed → count is
   `baseline + 1`), then cancel the reader; poll until
   `lifecycleBus.wildcardListenerCount` returns to `baseline`.

2. **Abrupt abort + subsequent bus emit returns to baseline.** Open with an
   `AbortController` signal, read the first frame, `abort()`, then emit a bus
   event (`lifecycleBus.emit("SessionStopped", { sessionId: "leak-test" })`) to
   drive any still-registered dead handler through its failing `enqueue`; poll
   until the count returns to `baseline`. This is the leak-specific case — if the
   handler did not self-clean, the count stays at `baseline + 1` and the poll
   times out.

Reference skeleton (adapt polling/timeouts to taste; keep it `bun:test`, no new
deps):

```ts
import { describe, expect, it } from "bun:test";
import { baseUrl } from "./server.helpers";
import { lifecycleBus } from "./services/lifecycle-bus";

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForCount(target: number, timeoutMs = 3000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (lifecycleBus.wildcardListenerCount === target) return target;
    await settle(25);
  }
  return lifecycleBus.wildcardListenerCount;
}

describe("SSE lifecycle-bus subscriber leak (plan 010)", () => {
  it("removes the bus handler on normal reader cancel", async () => {
    const baseline = lifecycleBus.wildcardListenerCount;
    const res = await fetch(`${baseUrl}/events/stream`, {
      headers: { Accept: "text/event-stream" },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(lifecycleBus.wildcardListenerCount).toBe(baseline + 1);

    await reader.cancel().catch(() => {});
    expect(await waitForCount(baseline)).toBe(baseline);
  });

  it("does not leak a handler after an abrupt abort", async () => {
    const baseline = lifecycleBus.wildcardListenerCount;
    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/events/stream`, {
      headers: { Accept: "text/event-stream" },
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    expect(lifecycleBus.wildcardListenerCount).toBe(baseline + 1);

    ac.abort();
    reader.cancel().catch(() => {});
    // Drive any still-registered dead handler through its failing enqueue.
    await settle(50);
    lifecycleBus.emit("SessionStopped", { sessionId: "leak-test" });

    expect(await waitForCount(baseline)).toBe(baseline);
  });
});
```

**Verify**: `cd apps/agent && bun test src/events-sse-leak.test.ts` → all pass
(2 tests).

### Step 4: Confirm no SSE regressions

**Verify**: `cd apps/agent && bun test sse` → all pass (this also runs
`server-sse-idle.test.ts`; nothing there should change).

## Test plan

- New file `apps/agent/src/events-sse-leak.test.ts` with two cases:
  - **Normal cancel** — handler count returns to baseline after `reader.cancel()`.
  - **Abrupt abort + emit** — handler count returns to baseline after `abort()`
    and a follow-up bus emit (the specific leak this plan fixes).
- Structural model: `apps/agent/src/server-sse-idle.test.ts` (same import of
  `baseUrl`, same `getReader()` + first-frame read).
- Both cases assert on `lifecycleBus.wildcardListenerCount` (added in Step 1) —
  a baseline-relative count, so they are robust to any other subscribers the
  shared in-process server may hold.
- Verification: `cd apps/agent && bun test src/events-sse-leak.test.ts` → all
  pass, 2 new tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0.
- [ ] `cd apps/agent && bun test src/events-sse-leak.test.ts` passes (2 new tests).
- [ ] `cd apps/agent && bun test sse` passes (no regression in
      `server-sse-idle.test.ts`).
- [ ] `grep -n "will be cleaned up in cancel()" apps/agent/src/routes/events-sse.ts`
      returns no matches (the swallow-and-defer comment is gone).
- [ ] `grep -n "cleanup()" apps/agent/src/routes/events-sse.ts` shows `cleanup()`
      called from the `busHandler` catch, the `keepalive` catch, and `cancel()`.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated (or reviewer owns the index).

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" does not match the excerpts (the
  handler or bus drifted since commit `64a206ff`).
- Adding `wildcardListenerCount` fails typecheck because `this.emitter` is not a
  `node:events` `EventEmitter` with a `listenerCount` method (the bus was
  re-implemented) — report the new shape.
- The abrupt-abort test cannot reach `baseline` even after the fix and a 3s poll
  — this would mean neither `cancel()` nor the self-clean catch fires in Bun for
  an aborted fetch; capture the observed final count and report, as it changes
  the risk assessment for this finding.
- The fix appears to require touching an out-of-scope file.

## Maintenance notes

For the human/agent who owns this code after the change lands:

- If a second SSE endpoint is added (e.g. `/specs/events`) with the same
  subscribe-in-`start` / unsubscribe-in-`cancel` shape, apply the identical
  `closed`-guarded `cleanup()` pattern — the leak class is per-handler, not
  per-route.
- `wildcardListenerCount` is a test-only affordance (like `currentSeq`); it reads
  the private emitter's `"*"` listener count. If the bus stops using a single
  wildcard listener per subscriber, update or remove it.
- A reviewer should scrutinize that `cleanup()` is idempotent (the `closed`
  guard) so the `cancel()` path and the catch path can both run without a
  double-`offAny` or double-`clearInterval`, and that the SSE frame format sent
  to clients is unchanged.
- Deliberately NOT covered: an explicit assertion that the keepalive interval was
  `clearInterval`'d — there is no clean external probe for a cleared timer, and
  the shared `cleanup()` clears it on the same guarded path as the (observable)
  handler removal. Verifying the listener count is the proxy; adding a timer spy
  would be over-engineering for this fix.

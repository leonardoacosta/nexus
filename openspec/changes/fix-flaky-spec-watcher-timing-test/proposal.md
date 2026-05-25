# fix-flaky-spec-watcher-timing-test

## Why

The agent unit test `spec-watcher fs.watch → lifecycleBus > [SpecB 5.2] tasks.md checkbox count
change emits a progress transition within 2s` is timing-flaky. On 2026-05-25 it blocked a push
(Tier A turbo test), failing at 2003.78ms against a hard 2000ms budget — a sub-4ms overage — and
cleared on retry (filed as `nx-qd7fh`).

Root cause in `apps/agent/src/services/spec-watcher-fs-watch.test.ts`:

- `waitForTransition(predicate, 2_000)` waits only 2000ms for the transition to arrive.
- `expect(elapsed).toBeLessThan(2_000)` then asserts a hard real-time SLA.

Both bake a **load-sensitive real-time latency bound into a correctness test**. The transition's
arrival time depends on fs.watch latency + the watcher's debounce + the mocked `openspec list`
re-poll + change detection — all of which jitter under machine load (here, the push ran the full
turbo suite concurrently). A 2s wall-clock assertion will always occasionally lose the race; this
is the same flake class as the previously-noted health-collector docker-socket flake.

A correctness test should assert that the `progress` transition fires with the right payload —
not that it arrives within an arbitrary 2 seconds. The 2s figure is a product latency target, not
a property a load-variable unit test can reliably assert.

## What Changes

### E2E Batch — make the test event-driven, not time-boxed

- In `apps/agent/src/services/spec-watcher-fs-watch.test.ts`, widen the `waitForTransition`
  deadline for the SpecB 5.2 test to a generous value (e.g. 8000ms) and raise the test's
  `{ timeout }` accordingly, so the test waits for the event rather than racing a tight window.
- Remove the brittle `expect(elapsed).toBeLessThan(2_000)` assertion. Keep ALL correctness
  assertions (transition is `progress`, `specName` is the progress spec, `completed`/`total`
  reflect the 4/5 update). If any latency bound is retained at all, it MUST be generous enough to
  catch only gross regressions (e.g. >= 5000ms), never a sub-second jitter.
- Rename/retitle the test so it no longer advertises a "within 2s" SLA it doesn't enforce
  (e.g. "emits a progress transition on checkbox-count change").
- Confirm the sibling SpecB 5.3 test is not similarly fragile (it already uses a 4s wait + 6s
  timeout with no `elapsed` assertion — leave it unless it shares the flaw).
- Validate by running the test repeatedly (e.g. 15-20 iterations) to confirm zero flakes.

## Context

- depends on: (none)
- touches: `apps/agent/src/services/spec-watcher-fs-watch.test.ts`

## Non-Goals

- Changing the spec-watcher's actual behavior or its debounce/re-poll latency (this is a
  test-reliability fix, not a watcher change).
- Adding a separate performance/latency test for the 2s product target (could be a future
  dedicated perf check; not in scope here).
- Touching the SpecB 5.3 archive test unless it shares the same brittle assertion.

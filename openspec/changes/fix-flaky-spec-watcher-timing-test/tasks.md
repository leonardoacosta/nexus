<!-- beads:epic:nx-sk3dc -->
<!-- beads:feature:nx-zpzfp -->

# Tasks: fix-flaky-spec-watcher-timing-test

## E2E Batch

De-flake the spec-watcher timing test. Touches `apps/agent/src/services/spec-watcher-fs-watch.test.ts`.

- [x] [1.1] In `apps/agent/src/services/spec-watcher-fs-watch.test.ts`, make the SpecB 5.2 test event-driven: widen the `waitForTransition(predicate, 2_000)` deadline to a generous value (e.g. `8_000`) and raise the test's `{ timeout: 4_000 }` accordingly (e.g. `12_000`). Remove the brittle `expect(elapsed).toBeLessThan(2_000)` assertion (and the now-unused `t0`/`elapsed` if they become dead). Keep ALL correctness assertions (transition `progress`, specName, completed=4/total=5). If you retain any latency bound, make it >= 5000ms. [owner:e2e-engineer] [type:testing] [beads:nx-blfvn]
- [x] [1.2] Retitle the test so it no longer advertises a "within 2s" SLA it does not enforce (e.g. "[SpecB 5.2] tasks.md checkbox count change emits a progress transition"). Update the file's top-of-file doc comment if it references the 2s budget as a test guarantee. [owner:e2e-engineer] [type:testing] [beads:nx-5p2ua]
- [x] [1.3] Confirm the sibling SpecB 5.3 test is not similarly fragile (it currently uses a 4s wait + 6s timeout with no `elapsed` assertion — leave it unless it shares the flaw). Note the determination. [owner:e2e-engineer] [type:testing] [beads:nx-9c6ag] — DETERMINATION: SpecB 5.3 is CLEAN. It uses `waitForTransition(predicate, 4_000)` + `{ timeout: 6_000 }`, captures NO `Date.now()`/`t0`/`elapsed`, and has NO `toBeLessThan` latency assertion. Its only assertions are `expect(env).not.toBeNull()`, transition `"removed"`, and specName — pure event-driven correctness. Does NOT share the hard-latency flaw. Left untouched.
- [x] [1.4] Validate: run `bun test apps/agent/src/services/spec-watcher-fs-watch.test.ts` repeatedly (15-20 iterations, e.g. a shell loop) and confirm ZERO flakes. Then run the broader `bun test apps/agent/src/services/` once to confirm no regression. Paste the green repeated-run evidence. [owner:e2e-engineer] [type:testing] [beads:nx-mr5br] — EVIDENCE: `TOTAL FAILS: 0 / 20`. Broader suite: 180 pass / 21 skip / 15 fail; the 15 fails are a PRE-EXISTING, unrelated barrel-export gap (`narrowSessionStatus` not re-exported from `packages/core/src/index.ts`) in processHookEvent + dispatcher tests — NOT in spec-watcher-fs-watch.test.ts and outside this test-reliability scope.

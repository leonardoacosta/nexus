<!-- beads:epic:nx-sk3dc -->
<!-- beads:feature:nx-sgh5u -->

# Tasks: fix-nx-yyy62-flaky-agent-test

## API Batch

Gate flake-resilience + capture, and harden the identifiable timing fragilities.

- [x] [1.1] In `deploy/hooks.d/pre-push/01-deploy`, wrap the Tier A `NEXUS_HEAVY_TESTS=1 pnpm test` step with retry-once: capture stdout, and on first failure append the failing test name(s) + ISO timestamp to a flake log (e.g. `~/.local/state/nexus/flake.log` or a repo-ignored path), then re-run the suite ONCE. Abort the push (`fail`) ONLY if the retry also fails. Preserve `SKIP_DEPLOY`/existing skip semantics. bash-3.2-safe. [owner:devops-engineer] [type:ci-cd] [beads:nx-07uyh]
- [x] [1.2] Harden the fixed-sleep timing fragilities: in `apps/agent/src/testing/homelab-transport.test.ts` replace the fixed `Bun.sleep(25/50)` poll loops with a `pollUntil(condition, deadlineMs)` helper (generous deadline), and gate the real-server/socket legs behind a reachability probe so they wait for readiness instead of racing a fixed budget. Apply the same pattern to the clearest sibling offender if one is obvious (e.g. a fixed-sleep poll in process-watcher/health-collector real-I/O tests). Keep all assertions intact. [owner:e2e-engineer] [type:testing] [beads:nx-8fh75]

## E2E Batch

Prove the gate resilience + suite stability.

- [x] [2.1] Verify the gate retry logic with a controlled harness (do NOT do a real push): a stub test that fails-once-then-passes makes the wrapped step PROCEED + writes the flake log; a stub test that always fails makes it ABORT after 2 attempts. Paste the evidence. [owner:e2e-engineer] [type:testing] [beads:nx-5n6wo]
- [x] [2.2] Stability: run `NEXUS_HEAVY_TESTS=1 bun test` (in `apps/agent`) 20x and confirm 0 fail; if any single run flakes, confirm the captured test name lands in the flake log and harden that test too. Paste the run summary. [owner:e2e-engineer] [type:testing] [beads:nx-1p1d6]

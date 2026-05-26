# fix-nx-yyy62-flaky-agent-test

## Why

The Tier A turbo test (`NEXUS_HEAVY_TESTS=1 pnpm test` in `deploy/hooks.d/pre-push/01-deploy`)
intermittently fails one `@nexus/agent` test, then passes on re-run (`nx-yyy62`). It blocked
nearly every push this session — each needing a manual retry. The failure is **load-dependent**:
14 isolated suite runs (plain + `NEXUS_HEAVY_TESTS=1` + the exact turbo command) all passed; it
only fires under the push-time concurrency (turbo runs 3 packages while the deploy build runs).

It is not one pinnable test but a **class** of timing-fragile tests: `homelab-transport.test.ts`
uses fixed `Bun.sleep(25/50)` poll loops against a real server/socket; `process-watcher.test.ts`
+ `health-collector.test.ts` exercise real Postgres/docker with implicit timing; several others
use fixed `setTimeout` waits. Under load any of these can miss its budget.

Manual-retry-on-flake is the current coping mechanism — it should be automatic, and the exact
offender should be captured so it can be fixed with evidence.

## What Changes

### CI: gate flake-resilience + capture (the deterministic relief)
- Wrap the Tier A `pnpm test` in the pre-push hook with **retry-once**: on first failure, append
  the failing test name(s) + timestamp to a flake log, then re-run the suite ONCE; abort the push
  only if the retry ALSO fails. A real regression fails both runs and still aborts; a flake passes
  on retry and proceeds — exactly the manual pattern, automated. Low risk, immediate payoff.

### Test hardening (root-cause, where identifiable)
- Replace fixed-`Bun.sleep` poll loops in `homelab-transport.test.ts` (and the clearest sibling
  offenders) with a `pollUntil(condition, generousDeadline)` helper, and gate real-I/O legs
  behind capability probes (reachable / hasPg / hasDocker) so they wait for readiness instead of
  racing a fixed budget.

### Verify
- Prove the gate retries a flaky-once failure (proceeds) but still aborts a hard failure (after 2),
  and that the flake log captures the offending test name.

## Context

- depends on: (none)
- touches: `deploy/hooks.d/pre-push/01-deploy`, `apps/agent/src/testing/homelab-transport.test.ts`

## Non-Goals

- Removing the integration gate or weakening its assertions (retry-once never lets a real failure
  through — it fails twice and aborts).
- A blanket rewrite of every fixed-sleep test — only the heavy/flake-prone offenders are hardened;
  the flake log drives targeted follow-ups for any others that surface.

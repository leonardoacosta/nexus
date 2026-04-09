# Change: Fix HealthScheduler redundant collection and Docker polling inefficiency

## Why

Two inefficiencies in the health-monitoring stack cause unnecessary system overhead. First,
`HealthScheduler.tick()` calls `collector.collect()` directly, which re-runs sysinfo queries
on every push interval — duplicating the work already done by the collector's own 5-second
background timer. It should read the cached snapshot via `collector.getLatest()` instead.
Second, Docker availability is re-checked via subprocess every 30 seconds indefinitely, even
when Docker is not installed, causing recurring wasted process spawns. A P3 companion issue
also exists: `HealthPoller.tsx` swallows `fetchHealth()` failures silently without logging a
warning to the user.

## What Changes

- `HealthScheduler.tick()` calls `collector.getLatest()` instead of `collector.collect()`;
  if the cache is empty (collector not yet warmed up) the tick is skipped with a debug log.
- Docker detection in `HealthCollector.collectDocker()` implements exponential backoff on
  failures: 30 s → 60 s → 120 s, capped at 10 min (600 s), so a machine without Docker
  wastes at most one subprocess call per cap window rather than one every 30 s indefinitely.
- `HealthPoller.tsx` logs a `console.warn` on `fetchHealth()` failure so stale data periods
  are visible in the browser console, matching the silent-catch behaviour documented in the
  spec.

## Impact

- Affected specs: `health-timeseries`
- Affected code:
  - `apps/agent/src/health-scheduler.ts` — replace `collect()` call with `getLatest()`
  - `apps/agent/src/health-collector.ts` — add Docker backoff state and skip logic
  - `apps/nextjs/src/components/HealthPoller.tsx` — add `console.warn` in catch block
  - `apps/agent/src/health-scheduler.test.ts` — update/extend tests
  - `apps/agent/src/health-collector.test.ts` — add Docker backoff tests

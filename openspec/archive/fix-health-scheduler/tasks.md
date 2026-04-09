## 1. HealthScheduler — use cached snapshot

- [x] 1.1 In `HealthScheduler.tick()`, replace `await this.collector.collect()` with
      `this.collector.getLatest()`; if the result is `null`, emit a debug log
      (`"health scheduler tick skipped — collector not yet warmed up"`) and return early
- [x] 1.2 Remove the now-unused `collect()` import/call path from `tick()`
- [x] 1.3 Update `health-scheduler.test.ts` — assert that the mock collector's `getLatest()`
      is called (not `collect()`) and verify the null/skip branch is tested

## 2. HealthCollector — Docker detection backoff

- [x] 2.1 Add backoff state to `HealthCollector`: `dockerBackoffUntil: number = 0`,
      `dockerBackoffMs: number = 30_000` (initial), cap at `600_000` (10 min)
- [x] 2.2 In `collectDocker()`, if `Date.now() < this.dockerBackoffUntil`, return `null`
      immediately without spawning a subprocess
- [x] 2.3 On Docker collection failure, double `dockerBackoffMs` (cap at 600 000 ms) and set
      `dockerBackoffUntil = Date.now() + dockerBackoffMs`; emit a debug log with
      `{ nextCheckMs: dockerBackoffMs }` to make the backoff observable
- [x] 2.4 On Docker collection success, reset `dockerBackoffMs` to `30_000` and clear
      `dockerBackoffUntil`
- [x] 2.5 Add tests in `health-collector.test.ts` covering: initial backoff on failure,
      doubling behaviour, cap at 10 min, and reset on success

## 3. HealthPoller — surface fetch failures

- [x] 3.1 In `HealthPoller.tsx`, replace the empty catch block in `poll()` with
      `console.warn("HealthPoller: fetchHealth failed — retaining stale data", err)`
      so stale-data periods are visible in the browser console

## 4. Quality gates

- [x] 4.1 Run `pnpm typecheck` — zero errors
- [x] 4.2 Run `pnpm lint` — zero new lint errors
- [x] 4.3 Run `pnpm test --filter=agent` — all tests pass

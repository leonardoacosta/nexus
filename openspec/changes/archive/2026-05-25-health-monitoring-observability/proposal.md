# health-monitoring-observability

## Why

Three health-monitoring gaps degrade observability. First, `healthSnapshots` lacks a committed
timestamp-index migration, so time-series queries over `health_snapshots.timestamp` are slow.
Second, `HealthCollector` (`apps/agent/src/health-collector.ts`) has no structured logging around
collection, so metric/docker errors are swallowed silently. Third, `HealthScheduler`
(`apps/agent/src/health-scheduler.ts`) reduces disk data into a single percent, losing per-disk
detail on multi-disk systems. These must be fixed so health time-series are fast, errors surface,
and multi-disk machines report fully.

## What Changes

Add a timestamp-index migration for `healthSnapshots` (schema + generated migration). Add
structured logging via the agent's `createLogger`/pino logger to `HealthCollector` so collection
errors surface instead of being swallowed. Fix `HealthScheduler` to capture all disks, not just a
single reduced value, on multi-disk systems. Add regression tests covering all three.

## Context

- depends on: `fix-drizzle-snapshot-desync`
- touches: `packages/db/src/schema/healthSnapshots.ts`, `packages/db/drizzle`, `apps/agent/src/health-collector.ts`, `apps/agent/src/health-scheduler.ts`

## Non-Goals

- Adding new health metrics beyond what `HealthCollector` already gathers (CPU, RAM, disk,
  docker) — this is an observability/correctness fix, not a metrics-expansion.
- Changing the Swift dashboards' rendering of health data (consumer-side display is out of scope).
- Building a retention/downsampling policy for `health_snapshots` (future work).

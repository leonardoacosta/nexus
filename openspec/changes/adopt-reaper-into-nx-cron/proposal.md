---
status: approved
approved-by: leo@leonardoacosta.dev
approved-at: 2026-05-21T11:02:40-05:00
---

# Proposal: Adopt the weekly-cleanup reaper into nx-cron

## Change ID

adopt-reaper-into-nx-cron

## Phase

Feature — folds an external, OS-timer-driven maintenance reaper into the
in-process nexus-agent cron service as a first-class, telemetered job.

## Why

The hardened "weekly-cleanup reaper" lives outside nx as a chezmoi-managed bash
script (`~/dev/if/home/dot_local/bin/executable_weekly-cleanup`, committed at
`if@8c49609`) driven by a macOS LaunchAgent and a Linux systemd timer. Its
results are invisible to nexus: no row lands in `cron_runs`, the bloat-radar
findings are never trended, and its notifications use a raw `osascript`
banner whose click attribution is wrong (opens the scripts folder, not the
run log). nx already owns an in-process cron service (`cron-persistence`
capability) and a centralized SQLite datastore — the reaper belongs there.

## What Changes

- Port the proven destructive bash core verbatim into nx as a vendored script
  invoked as a child process from a thin TypeScript job wrapper (no
  reimplementation of destructive logic in TS).
- Register a `reaper` job in the existing nexus-agent `CronService`
  (weekly, Sunday 03:00 local) that spawns the bash core, parses its
  structured output, and writes a `cron_runs` row.
- Add a `bloat_radar` telemetry table so radar findings are trendable and
  dashboard-visible; keep the dedicated spoken TTS warning.
- Extend the `NotificationFired` payload (and its Swift mirror) with
  `items[]` and `logPath`; teach the Mac listener renderer to render findings
  as a bullet list and make clicking the banner open the run log (fixes the
  current raw-`osascript` click-attribution bug for ALL nx notifications).
- Add a missed-run / stale-heartbeat detector: if the reaper has not
  succeeded in > 8 days, fire a loud TTS + notification (ports the bash
  prior-run-stale heartbeat into SQLite).
- **BREAKING / CLEAN CUT**: remove the chezmoi reaper, its macOS LaunchAgent,
  and its Linux systemd `.timer` + `.service` from `~/dev/if`, sequenced last
  so the two schedulers can never both fire Sunday 03:00.

## Accepted Risk (explicit, knowingly chosen)

nx-cron + clean-cut means there is no OS-timer watchdog. If the nexus-agent /
cron service is down on a Sunday, that week's reap is skipped silently. The
user has chosen this trade knowingly; **no OS-timer fallback is added**. The
sole compensating control is the `cron_runs` missed-run / stale-heartbeat
detector (> 8 days without a successful `reaper` row → loud TTS + notification),
which is a hard requirement of this change.

## Destructive-Safety Invariants (preserved verbatim through the port)

- `node_modules` and `.git` under `~/dev` are NEVER touched.
- `.turbo` / `.next` / `*.bun-build` sweeps are age-gated to > 7 days.
- Active logs are TRUNCATED (inode/fd preserved), never deleted.
- The bash core retains `set -u` only (NOT `set -e` / `pipefail`); every
  step stays `|| true`-guarded; the `_on_exit` silent-abort trap and the
  completion sentinel are preserved.
- `--dry-run` and idempotency survive the TS wrapper (the wrapper forwards
  `--dry-run` to the child process and asserts zero deletions in dry mode).

## Context

- depends on: `apps/agent/src/services/cron.ts`, `apps/agent/src/services/lifecycle-bus.ts`, `apps/swift/NexusShared/Models/Notification.swift`, `packages/db/src/schema/index.ts`
- touches: `apps/agent/src/services/cron.ts`, `apps/agent/src/services/reaper-core.sh`, `apps/agent/src/services/reaper-job.ts`, `apps/agent/src/routes/cron-routes.ts`, `apps/agent/src/notifications/manager.ts`, `apps/agent/src/services/lifecycle-bus.ts`, `apps/swift/NexusShared/Models/Notification.swift`, `apps/swift/nexus-mac/Sources/AppNavigation.swift`, `packages/db/src/schema/cronRuns.ts`, `packages/db/src/schema/bloatRadar.ts`, `packages/db/src/schema/index.ts`, `packages/db/drizzle/0031_add_reaper_telemetry.sql`, `home/dot_local/bin/executable_weekly-cleanup`, `home/Library/LaunchAgents/com.leonardoacosta.weekly-cleanup.plist`, `home/dot_config/systemd/user/weekly-cleanup.timer`, `home/dot_config/systemd/user/weekly-cleanup.service`

> Path note: the four `home/...` entries above are cross-repo removals in
> `~/dev/if` (chezmoi source root). They are listed here so the implementation
> plan is complete; the clean-cut tasks delete them in the final batch.

## Conflicts With In-Flight Changes

Active changes inspected: `folder-based-project-autodiscovery`,
`fix-credential-source-divergence`, `socket-dispatcher-parity`.

- `folder-based-project-autodiscovery` touches
  `packages/db/src/schema/projects.ts` and `routes/projects.ts` — **no
  overlap** (this change adds new schema files `cronRuns.ts`, `bloatRadar.ts`
  and touches `routes/cron-routes.ts`, not `projects.ts`).
- `fix-credential-source-divergence` touches credential subsystem files —
  **no overlap**.
- `socket-dispatcher-parity` touches `services/socket-server/dispatcher.ts`
  and `routes/hooks.ts` — **no overlap** with the cron/notification surfaces
  here. Soft note only: both this change and the spine-migration line append
  to `packages/db/src/schema/index.ts`; this is an append-only export list,
  so the conflict resolves trivially at merge.

No hard conflicts. No coordination required beyond the trivial `index.ts`
append.

## Impact

- Affected specs: `cleanup` (ADDED), `cron-persistence` (ADDED),
  `notification-store` (ADDED).
- Affected code: `apps/agent` cron + notification surfaces, `packages/db`
  schema + a Drizzle migration, `apps/swift` notification model + Mac
  renderer, and the cross-repo `~/dev/if` reaper artifacts (removed).

---
order: 0716a
---

# Nexus Self-Healing Infrastructure

## Context

Leo asked for nexus to become "self healing." Discovery found substantial existing resilience
infrastructure that must NOT be re-implemented (reuse-before-reinvention):

- `deploy/nexus-agent.service` already has `Restart=always` + `StartLimitBurst=5` (crash-restart
  is solved on Linux). macOS runs no agent daemon (Swift app only), whose presence sensor already
  has `KeepAlive=true`.
- `deploy/hooks.d/post-merge/02-deploy` already self-heals `bun.lock` frozen-install drift and
  fans out to remote agents with pass/fail notifications.
- `apps/agent/src/services/cron.ts` (`CronService`) already runs weekly `drift` and `reaper`
  jobs, and `apps/agent/src/services/reaper-job.ts` already implements a heartbeat/staleness
  pattern (`checkReaperHeartbeat` + `emitStaleHeartbeatNotification`, 12h notify cooldown
  persisted via `state-snapshot`) — this is the template this proposal reuses for deploy
  staleness, not a new pattern.
- `packages/db/src/migrate.ts` already exports `selfHealingMigrate()` — a hardened, tested
  (`migrate.test.ts`) migration replay that tolerates legacy pre-existing objects, never `db:push`.
  It is currently only invoked by the `bun ./src/migrate.ts` CLI entrypoint, never by the running
  agent.
- `apps/agent/src/db/database.ts` `verifySchema()` currently fatal-exits (`SchemaIncompleteError`,
  `process.exit(1)`) when required tables are missing — deliberately fail-closed per the
  nx-dbame 7-week-silent-outage incident (`openspec/specs/quality-gate-hardening`). It only
  *instructs* the operator to run `db:migrate`; it never runs it.
- `apps/agent/src/services/schema-drift.ts` only fingerprints hook *payload* shape drift, not DB
  row-level integrity (e.g. the projects-table duplicate-row explosion, resolved manually via
  migration 0049 — no recurring guard exists for that class today).

Given that inventory, this proposal is narrower than "self healing" implies. Leo confirmed via
clarifying questions (2026-07-16):
- data-integrity findings are **detect + alert only** — no unattended repair against the shared
  homelab Postgres instance (Breaking-Changes policy: destructive/ambiguous DB actions require
  Leo's confirmation).
- agent liveness gets a **heartbeat watchdog** (`WatchdogSec` + `sd_notify`) on top of the
  existing crash-restart, to catch a hung-but-not-exited process.
- deploy staleness gets **alert + automatic retry with backoff** (not alert-only).
- the startup schema gate **auto-runs `selfHealingMigrate()`** (already-committed migrations
  only — never `db:push`, never `db:generate`) instead of fatal-exiting, for the common
  "forgot to migrate before restarting the agent" case.

- depends on: (none)
- touches: `deploy/nexus-agent.service`, `apps/agent/src/index.ts`, `apps/agent/src/db/database.ts`, `packages/db/src/index.ts`, `apps/agent/src/services/cron.ts`, `apps/agent/src/services/data-integrity-scan.ts`, `apps/agent/src/services/deploy-staleness.ts`, `deploy/hooks.d/post-merge/02-deploy`, `deploy/lib/deploy-retry.sh`

## What Changes

1. **Heartbeat watchdog** (systemd-service): the agent periodically notifies systemd
   (`sd_notify WATCHDOG=1`) via the `$NOTIFY_SOCKET` datagram socket; `nexus-agent.service`
   declares `WatchdogSec=`. If the main loop hangs (event loop blocked, deadlock) and stops
   notifying, systemd kills and restarts the unit — closing the gap crash-restart doesn't cover
   (a wedged-but-alive process never trips `Restart=always`, which only fires on process exit).

2. **Deploy staleness watchdog + retry** (remote-deploy-fanout): the remote SSH fan-out in
   `deploy/hooks.d/post-merge/02-deploy` retries a failed remote deploy with capped backoff
   before giving up and alerting (mirrors the `tier-a-retry.sh` retry-once shape, extended to
   N attempts). Separately, a new weekly `deploy-staleness` cron job (registered in
   `CronService`, following the `checkReaperHeartbeat` pattern byte-for-byte) SSHes each
   configured remote agent, compares its deployed `git rev-parse HEAD` against local HEAD, and
   emits a notification (12h cooldown, same as reaper) when a remote has been behind for longer
   than a grace window — catching the "silent for 49h" incident class even when the retries
   above are exhausted.

3. **Data-integrity scan (detect + alert only)** (db-integrity): a new weekly `data-integrity`
   cron job scans for known bad-data signatures — starting with the projects-table duplicate-row
   pattern (the migration-0049 incident) — and, on a match, emits a notification naming the
   affected table/rows and the manual repair command. It writes zero rows; it is read-only
   against the live DB.

4. **Startup auto-migrate** (quality-gate-hardening): `verifySchema()`'s `SchemaIncompleteError`
   path calls the already-exported-for-this-purpose `selfHealingMigrate()` (newly re-exported
   from `packages/db`'s public index) once, then re-verifies. If tables are still missing after
   the auto-migrate attempt, it fatal-exits exactly as today (the fail-closed backstop is
   preserved — this only removes the "I forgot to migrate" case, never masks a genuinely broken
   migration).

## Non-Goals

- No automatic repair of detected data-integrity findings (alert-only, per Leo's decision).
- No macOS agent daemon watchdog (no such daemon exists — out of scope by design, see
  `systemd-service` § No macOS nexus-agent daemon in deploy).
- No change to the `db:push` ban (never invoked) or migration-authoring workflow — `selfHealingMigrate()` only
  replays already-committed migrations, same as the manual `db:migrate` path today.

## Testing

- Heartbeat watchdog: unit test for the `sd_notify` helper (mock `$NOTIFY_SOCKET` datagram
  writes); manual verification note for `WatchdogSec` behavior (requires a real systemd user
  instance — not CI-automatable, documented as a manual verification step in tasks.md).
- Deploy retry + staleness: `deploy/tests/*.test.sh` additions for the retry-with-backoff helper
  (mirrors `deploy/tests/tier-a-retry.test.sh`) and a unit test for the staleness comparison
  logic under `apps/agent/src/services/deploy-staleness.test.ts`.
- Data-integrity scan: `apps/agent/src/services/data-integrity-scan.test.ts` — unit tests against
  a seeded duplicate-row fixture, asserting detection fires and zero writes occur.
- Auto-migrate: `apps/agent/src/db/database.test.ts` addition — `verifySchema()` calls
  `selfHealingMigrate()` exactly once on `SchemaIncompleteError` and re-throws if still
  incomplete after the attempt.

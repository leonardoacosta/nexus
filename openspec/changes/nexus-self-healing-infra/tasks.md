<!-- beads:epic:nx-c31zq -->
<!-- beads:feature:nx-he6ni -->

# Tasks — nexus-self-healing-infra

## DB Batch

- [x] 1.1 Export `selfHealingMigrate` from `packages/db/src/index.ts` (currently only used [beads:nx-5xz7q]
      internally by `packages/db/src/migrate.ts`'s CLI entrypoint). No new migration, no schema
      change — a public-API export only.
      - touches: `packages/db/src/index.ts`

## API Batch

- [x] 2.1 Add an `sd_notify` helper (e.g. `apps/agent/src/services/sd-notify.ts`) that writes a [beads:nx-p9rqs]
      `WATCHDOG=1` datagram to `$NOTIFY_SOCKET` when set, and no-ops silently when unset (local
      dev, macOS). Wire a periodic call (interval < half of the configured `WatchdogSec`) into
      the agent's main loop startup in `apps/agent/src/index.ts`.
      - touches: `apps/agent/src/services/sd-notify.ts`, `apps/agent/src/index.ts`
      - implementation note: Bun's `node:dgram` only supports `udp4`/`udp6` (verified — throws
        "Bad socket type specified" for `unix_dgram`) and `node:net`/`Bun.connect` only speak
        `SOCK_STREAM`, which the kernel refuses to connect to systemd's `SOCK_DGRAM` notify
        socket. Implemented via `bun:ffi` calling libc `socket`/`connect`/`write`/`close`
        directly (ships with Bun — not a new npm dependency). Verified end-to-end with a real
        bound `AF_UNIX SOCK_DGRAM` listener receiving the literal `WATCHDOG=1\n` bytes.
- [x] 2.2 Add `WatchdogSec=30` to `deploy/nexus-agent.service` (alongside the existing [beads:nx-bslpj]
      `Restart=always`/`RestartSec=5`/`StartLimitBurst=5`).
      - touches: `deploy/nexus-agent.service`
- [x] 2.3 In `apps/agent/src/db/database.ts`, change `verifySchema()`'s `SchemaIncompleteError` [beads:nx-hg34x]
      path: on first detection of missing tables, call the newly-exported `selfHealingMigrate()`
      once, then re-run the missing-tables probe. Only throw `SchemaIncompleteError` (fatal-exit
      path in `apps/agent/src/index.ts` unchanged) if tables are still missing after the attempt.
      - touches: `apps/agent/src/db/database.ts`
      - implementation note: the Drizzle `Db` instance already carries the raw `postgres.Sql`
        client at `db.$client` (drizzle-orm's postgres-js driver types `drizzle(client, ...)` as
        `PostgresJsDatabase & { $client: TClient }`) — no new client/pool plumbing needed.
- [x] 2.4 Extract a shared `get_remote_agents`-style parser (already in [beads:nx-eff6w]
      `deploy/hooks.d/post-merge/02-deploy`) into a small sourceable lib
      (`deploy/lib/remote-agents.sh`) so both the deploy hook and the new staleness check reuse
      one implementation instead of two copies drifting apart.
      - touches: `deploy/lib/remote-agents.sh`, `deploy/hooks.d/post-merge/02-deploy`
- [x] 2.5 Add a retry-with-backoff wrapper (`deploy/lib/deploy-retry.sh`, modeled on [beads:nx-695re]
      `deploy/lib/tier-a-retry.sh`'s shape) and use it around the per-remote SSH deploy call in
      `deploy/hooks.d/post-merge/02-deploy`'s fan-out loop: up to 3 attempts, 10s then 30s
      backoff, exactly one success/failure notification per remote regardless of attempt count.
      - touches: `deploy/lib/deploy-retry.sh`, `deploy/hooks.d/post-merge/02-deploy`
- [x] 2.6 Add `apps/agent/src/services/deploy-staleness.ts`: for each remote in `agents.toml` [beads:nx-82qv1]
      (via the shared parser from 2.4, invoked over SSH), compare remote `git rev-parse HEAD`
      against local HEAD; persist result to `cron_runs` (`job="deploy-staleness"`); on a
      >24h-stale remote, emit a notification via `lifecycleBus` with a 12h cooldown (reuse the
      exact `checkReaperHeartbeat`/`emitStaleHeartbeatNotification` shape from
      `apps/agent/src/services/reaper-job.ts` — same cooldown constant pattern, same
      `state-snapshot` persistence for the cooldown timestamp).
      - touches: `apps/agent/src/services/deploy-staleness.ts`
- [x] 2.7 Register the `deploy-staleness` job in `apps/agent/src/services/cron.ts` on the [beads:nx-2uk0o]
      existing weekly schedule-calculation helper (same pattern as `drift`/`reaper`).
      - touches: `apps/agent/src/services/cron.ts`
- [x] 2.8 Add `apps/agent/src/services/data-integrity-scan.ts`: a read-only query for the [beads:nx-wc5yw]
      projects-table duplicate-identity signature (the migration-0049 pattern — see
      `packages/db/drizzle/` for the historical dedup migration's WHERE-clause shape to mirror
      as a detection query). Persist to `cron_runs` (`job="data-integrity"`); on a match, emit a
      notification naming the table, finding count, and the manual repair command. Zero writes
      under all code paths.
      - touches: `apps/agent/src/services/data-integrity-scan.ts`
- [x] 2.9 Register the `data-integrity` job in `apps/agent/src/services/cron.ts` on the existing [beads:nx-ehnmm]
      weekly schedule-calculation helper.
      - touches: `apps/agent/src/services/cron.ts`

## E2E Batch

- [x] 3.1 `apps/agent/src/services/sd-notify.test.ts` — asserts the datagram write happens when [beads:nx-dqyuk]
      `$NOTIFY_SOCKET` is set (mock socket) and is a silent no-op when unset.
- [x] 3.2 `apps/agent/src/db/database.test.ts` addition — `verifySchema()` calls [beads:nx-x9zua]
      `selfHealingMigrate()` exactly once on `SchemaIncompleteError`, proceeds on success,
      re-throws `SchemaIncompleteError` if tables are still missing after the attempt.
- [x] 3.3 `deploy/tests/deploy-retry.test.sh` (new, modeled on [beads:nx-uj8l0]
      `deploy/tests/tier-a-retry.test.sh`) — asserts retry-then-succeed fires exactly one success
      notification, and exhausted-retries fires exactly one failure notification after the
      documented backoff.
- [x] 3.4 `apps/agent/src/services/deploy-staleness.test.ts` — unit tests for the HEAD-comparison [beads:nx-0a3hb]
      logic, the 24h staleness threshold, the 12h notification cooldown, and graceful handling of
      an unreachable remote (logs and continues, does not throw).
- [x] 3.5 `apps/agent/src/services/data-integrity-scan.test.ts` — seeded fixture with duplicate [beads:nx-lkvte]
      project rows asserts detection fires and zero writes occur; a clean fixture asserts no
      notification fires.
- [ ] 3.6 Manual verification note (not CI-automatable): after `WatchdogSec=30` deploys, confirm [beads:nx-xz1u4]
      `systemctl --user show nexus-agent -p WatchdogTimestamp` advances, and that killing the
      agent's event loop (e.g. a deliberate infinite synchronous loop in a debug build) results
      in a systemd-initiated restart within `WatchdogSec` + a few seconds.

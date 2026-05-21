# Tasks: Adopt the weekly-cleanup reaper into nx-cron

<!-- beads:epic:nx-zl0yb -->
<!-- beads:feature:nx-ylqm0 -->

## DB Batch

- [x] 1.1 Add `packages/db/src/schema/cronRuns.ts` — `cron_runs` table (id, [beads:nx-8hrn9]
  timestamp, job text, status text, details text/json, metrics text/json),
  with an index on `timestamp` mirroring `healthSnapshots` conventions
- [x] 1.2 Add `packages/db/src/schema/bloatRadar.ts` — `bloat_radar` table [beads:nx-cougs]
  (id, runTimestamp, label, path, sizeBytes, thresholdBytes), index on
  `runTimestamp`
- [x] 1.3 Export `cronRuns` and `bloatRadar` from [beads:nx-fi6ob]
  `packages/db/src/schema/index.ts` (append-only, after the existing exports)
- [x] 1.4 Generate the Drizzle migration [beads:nx-rm4lq]
  `packages/db/drizzle/0033_add_reaper_telemetry.sql` via drizzle-kit (do not
  hand-write SQL) and verify it creates both tables + indices (renumbered
  from 0031 → 0033; 0031 and 0032 were already taken by in-flight changes)
- [x] 1.5 Add a retention rule for `cron_runs` and `bloat_radar` in [beads:nx-y4ddo]
  `apps/agent/src/db/retention.ts` consistent with the existing 30/90-day
  retention pattern (choose a sensible window, default 90 days)

## API Batch

- [x] 2.1 Vendor the destructive bash core verbatim into [beads:nx-v4khg]
  `apps/agent/src/services/reaper-core.sh` — port from
  `~/dev/if/home/dot_local/bin/executable_weekly-cleanup` (`if@8c49609`):
  `set -u` only (NO `set -e`/pipefail), `_on_exit` silent-abort trap,
  completion sentinel + success-heartbeat write, age-gated > 7d
  `.turbo`/`.next`/`*.bun-build` sweep that prunes `node_modules`/`.git`,
  truncate-not-delete for active logs, stray `$HOME/*.Default.w*.log`
  deletion, `bloat_radar()` scan, cross-platform macOS/Linux branches
- [x] 2.2 Make `reaper-core.sh` emit machine-parseable result lines (counts, [beads:nx-dvsqr]
  freed bytes, per-finding bloat lines) the wrapper can parse without
  regressing the human log
- [x] 2.3 Add `apps/agent/src/services/reaper-job.ts` — thin TS wrapper that [beads:nx-ejvfx]
  spawns `reaper-core.sh` as a child process, forwards `--dry-run`, captures
  stdout/stderr, parses counts + bloat findings, and resolves a structured
  result (status, pruned, freedBytes, durationMs, bloatFindings[], logPath)
- [x] 2.4 Persist the wrapper result to `cron_runs` (success and [beads:nx-o540k]
  aborted/failure paths) per the `cron-persistence` deltas
- [x] 2.5 Persist each bloat finding to the `bloat_radar` table; emit no rows [beads:nx-wl3hy]
  on a "clear" run
- [x] 2.6 Register the `reaper` job in [beads:nx-lz7po]
  `apps/agent/src/services/cron.ts` — weekly Sunday 03:00 via
  `msUntilWeeklyAt(0, 3, 0)`, wired into `startCronService()` alongside
  `maintain`/`drift`, with reschedule-after-run
- [x] 2.7 Implement the missed-run / stale-heartbeat detector: on cron [beads:nx-3xup4]
  service start and before each reaper tick, query `cron_runs` for the latest
  `job="reaper" status="success"` row; if older than 8 days or absent, emit a
  loud TTS + desktop notification
- [x] 2.8 Extend `NotificationFiredPayload` in [beads:nx-iq3d6]
  `apps/agent/src/services/lifecycle-bus.ts` with optional `items?: string[]`
  and `logPath?: string`; thread them through
  `apps/agent/src/notifications/manager.ts` `lifecycleBus.emit` call
- [x] 2.9 Emit the reaper completion notification with `items` (bullet [beads:nx-ifosx]
  findings) + `logPath`, and a separate dedicated bloat TTS when findings
  exist (reuse the existing manager/router signal-only path)
- [x] 2.10 Update `apps/agent/src/routes/cron-routes.ts` so `GET /cron` [beads:nx-ttpsg]
  reports the `reaper` job (schedule, last_run, last_status, last_log) from
  the `cron_runs` table instead of the hardcoded `null` stub
- [x] 2.11 Unit-test the wrapper (`reaper-job.ts`): dry-run performs zero [beads:nx-tp8p1]
  mutations and is idempotent; output parsing extracts counts + bloat
  findings; aborted child yields a failure result
- [x] 2.12 Unit-test the stale-heartbeat detector: stale/absent → warn, [beads:nx-1una8]
  fresh → silent
- [x] 2.13 Unit-test the `cron_runs` / `bloat_radar` persistence against the [beads:nx-rfrh2]
  real test DB (no Drizzle mocking, per project test convention)

## UI Batch

- [x] 3.1 Extend the Swift `NotificationEvent` mirror in [beads:nx-ds60x]
  `apps/swift/NexusShared/Models/Notification.swift` with optional
  `items: [String]?` and `logPath: String?`, keeping Codable back-compat
- [x] 3.2 Update the Mac listener notification renderer [beads:nx-838kq]
  (`apps/swift/nexus-mac` SSE consumer) to render a non-empty `items` array
  as a bullet list instead of one run-on banner line
- [x] 3.3 Make notification activation open `logPath` via the OS default [beads:nx-nx294]
  handler when present; fall back to default activation when absent (fixes
  the raw-osascript click-attribution bug for all nx notifications)
- [x] 3.4 Add/extend a Swift test asserting items→bullet rendering and [beads:nx-aad5a]
  logPath→open-log activation, including the no-logPath fallback

## E2E Batch

- [x] 4.1 End-to-end: trigger the `reaper` job with `--dry-run`, assert a [beads:nx-oe4kw]
  `cron_runs` row is written, zero filesystem mutations occurred, and the
  completion notification payload carries `items` + `logPath`
  (Covered by `apps/agent/src/services/reaper-job.e2e.test.ts` — describe
  block "reaper E2E [4.1] — real dry-run against sandboxed $HOME". Gated
  behind `POSTGRES_URL` + `NEXUS_RUN_LIVE_REAPER_TESTS=1`; skips cleanly
  otherwise per the project test convention.)
- [x] 4.2 End-to-end: seed a synthetic over-threshold bloat target, run the [beads:nx-3kke1]
  reaper (dry-run), assert a `bloat_radar` row is persisted and the dedicated
  bloat TTS path is exercised
  (Covered by `apps/agent/src/services/reaper-job.e2e.test.ts` — describe
  block "reaper E2E [4.2] — synthetic bloat seed exercises bloat_radar +
  dedicated TTS". The "synthetic seed" is a stub script that emits the
  same NEXUS_BLOAT protocol the real script would on a 40 GiB CoreSimulator
  dir, driving the production parser -> persister -> notifier path verbatim
  without requiring multi-GB of real disk. Asserts the dedicated bloat TTS
  emit (channel="tts", title "Disk bloat warning").)
- [ ] [deferred] 4.3 CLEAN CUT — remove the chezmoi reaper script from `~/dev/if`: [beads:nx-h7gs3]
  delete `home/dot_local/bin/executable_weekly-cleanup`
  (Deferred — cross-repo edit in ~/dev/if, out of scope for this Nexus
  worktree dispatch. /apply:all Phase 4 will file a P4 backlog issue.)
- [ ] [deferred] 4.4 CLEAN CUT — remove the macOS LaunchAgent from `~/dev/if`: [beads:nx-ka5qp]
  delete `home/Library/LaunchAgents/com.leonardoacosta.weekly-cleanup.plist`
  and `launchctl unload` any deployed copy so it cannot fire Sunday 03:00
  (Deferred — cross-repo edit in ~/dev/if, out of scope for this Nexus
  worktree dispatch. /apply:all Phase 4 will file a P4 backlog issue.)
- [ ] [deferred] 4.5 CLEAN CUT — remove the Linux systemd units from `~/dev/if`: [beads:nx-3kjkj]
  delete `home/dot_config/systemd/user/weekly-cleanup.timer` and
  `weekly-cleanup.service`, and `systemctl --user disable --now` any deployed
  copy
  (Deferred — cross-repo edit in ~/dev/if, out of scope for this Nexus
  worktree dispatch. /apply:all Phase 4 will file a P4 backlog issue.)
- [ ] [deferred] 4.6 Sequence verification: confirm steps 4.3–4.5 run only AFTER the [beads:nx-x2rab]
  nx `reaper` job is registered and verified (2.6), so the two schedulers
  can never both fire on the same Sunday 03:00
  (Deferred — depends on 4.3–4.5 which are themselves deferred to a
  cross-repo follow-up. /apply:all Phase 4 will file a P4 backlog issue.)
- [ ] [deferred] 4.7 Verify cross-platform parity: the reaper produces the expected [beads:nx-ftjrt]
  macOS sweep set and the expected Linux homelab sweep set with equivalent
  destructive-safety invariants
  (Deferred — requires production deployment + homelab observation, out of
  scope for an automated dispatch. /apply:all Phase 4 will file a P4
  backlog issue.)

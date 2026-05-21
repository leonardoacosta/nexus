## Context

The weekly-cleanup reaper is a hardened, battle-tested bash script
(`~/dev/if/home/dot_local/bin/executable_weekly-cleanup`, `if@8c49609`) that
already survived a real disk-fill incident. nx owns an in-process
`CronService` (`apps/agent/src/services/cron.ts`) with `maintain`/`drift`
jobs, a centralized SQLite datastore, and a signal-only notification spine
where the agent emits `NotificationFired` on `lifecycleBus` and the Mac
listener (`apps/swift/nexus-mac` via `NexusShared.NotificationEvent`) does
all rendering. All design decisions for this adoption are LOCKED by the user.

## Goals / Non-Goals

- Goals: telemeter the reaper into `cron_runs` + `bloat_radar`; one scheduler
  (nx-cron); structured bullet-list notification with click→open-log;
  stale-heartbeat watchdog; clean-cut removal of the if-side artifacts.
- Non-Goals: reimplementing destructive logic in TS; an OS-timer fallback
  (explicitly rejected by the user); a phased/coexistence rollout.

## Decisions

- **HYBRID port.** The proven bash core is vendored verbatim into
  `apps/agent/src/services/reaper-core.sh` and spawned as a child process by
  `reaper-job.ts`. Rationale: the destructive guards (`set -u`-only, `||
  true`, `_on_exit` trap, completion sentinel, age gates, truncate-not-delete)
  are the safety contract — rewriting them in TS would re-litigate a solved,
  incident-hardened problem. The wrapper owns only orchestration: spawn,
  parse, persist, notify.
- **Notification seam = `NotificationFired` lifecycle payload.** The agent is
  signal-only post-`remove-notification-channels`/`swift-owns-elevenlabs-synth`;
  the renderer/click behavior lives Swift-side. So `items[]`/`logPath` are
  added to `NotificationFiredPayload` (TS) AND its `NexusShared.NotificationEvent`
  mirror (Swift), and the bullet-list + click→open-log fix lands in the Mac
  renderer. This is why the fix benefits ALL nx notifications, not just the
  reaper.
- **Telemetry tables follow `healthSnapshots` conventions** (pgTable,
  generated-identity id, timestamp index) and ship via a drizzle-kit
  migration — no hand-written SQL (project convention).
- **Stale-heartbeat in SQLite, not a heartbeat file.** The bash prior-run
  health check (`> 8d` since last success) is reimplemented as a `cron_runs`
  query so it survives the clean cut and is the sole compensating control for
  the no-watchdog risk.

## Risks / Trade-offs

- **No OS watchdog (ACCEPTED).** If nexus-agent is down on a Sunday, that
  week's reap is skipped. Mitigation: the > 8d stale-heartbeat detector fires
  loud TTS + notification on next service start / next tick.
- **Two schedulers transiently.** Mitigated by sequencing: the if-side
  removal (E2E Batch 4.3–4.6) runs only after the nx job is registered and
  verified, and explicitly unloads/disables any deployed LaunchAgent/timer so
  both can never fire the same Sunday 03:00.
- **Cross-repo edit.** The clean-cut tasks edit `~/dev/if` (chezmoi source).
  Declared in `proposal.md` Context `- touches:` for completeness.

## Migration Plan

1. DB Batch: schema + migration + retention.
2. API Batch: vendor core, wrapper, cron registration, persistence,
   stale-heartbeat, notification payload extension.
3. UI Batch: Swift mirror + renderer (bullets + click→log).
4. E2E Batch: dry-run e2e, then sequenced clean-cut removal in `~/dev/if`,
   then parity verification.

Rollback: if the nx job regresses before clean-cut, revert the API/UI
batches; the if-side artifacts are untouched until E2E Batch, so the OS-timer
reaper remains the fallback right up to the cut.

## Open Questions

- None. All decisions locked by the user.

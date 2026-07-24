---
order: 0724j
---

# Proposal: Route Service-Originated Notifications Through NotificationManager

## Change ID
`route-service-notifications-through-manager`

## Summary
Five internal agent services fire `tts`/`desktop` `NotificationFired` lifecycle events by calling
`lifecycleBus.emit("NotificationFired", ...)` directly, bypassing `NotificationManager.send()` —
the ONLY place meeting-hold (Rule 2), presence-aware Rule 1, quiet hours, and rate-throttling are
applied. Route all five through the manager instead, so a service-originated notification gets the
same gating a hook-triggered one already gets.

## Context
- depends on:
- touches: `apps/agent/src/services/proactive-swap.ts`, `apps/agent/src/services/reaper-job.ts`, `apps/agent/src/services/deploy-staleness.ts`, `apps/agent/src/services/data-integrity-scan.ts`, `apps/agent/src/services/credential-swap-flow.ts`, `apps/agent/src/notifications/manager.ts`, `apps/agent/src/notifications/manager.integration.test.ts` (new)
- base-commit: nexus@9e4963b9

## Motivation
Found via `/explore` ("nexus headroom tts plays all at once, why?", 2026-07-24).
`NotificationManager.send()` (`manager.ts:200-330`) is
the only call path that checks `meetingState.active` / presence-aware Rule 1 / quiet hours / rate
throttle before delivering. Five services skip it entirely:

- `services/proactive-swap.ts:241-242` (`runLadder` — credential-headroom exhaustion ladder,
  fires per threshold crossed, e.g. two notifications back-to-back when a fast usage jump crosses
  both 10% and 8% in one poller tick)
- `services/reaper-job.ts:454,471,601,609`
- `services/deploy-staleness.ts:397,406`
- `services/data-integrity-scan.ts:206,214`
- `services/credential-swap-flow.ts:129-130`

Each defaults its injectable `notify` option to `(p) => lifecycleBus.emit("NotificationFired", p)`
— a direct bus emit with no DB row (`insertNotification` never runs for these), no meeting check,
no throttle. The just-archived `meeting-detection-running-app-gate`
(`openspec/changes/archive/2026-07-21-meeting-detection-running-app-gate/`) improved the presence
*sensor* `rules-engine.ts` consults, but these five sources never reach `rules-engine.ts` at all —
so TTS from any of them will keep interrupting mid-meeting regardless of that fix. The only
surviving gate for them is the client-side `settings.ttsEnabled` toggle in
`apps/swift/NexusShared/Observers/TTSObserver.swift:575` (Mac-side only, and per-device).

## Testing
- `manager.integration.test.ts` (new cases): a service-shaped notification (id/title/body/channel,
  no `project`) submitted via the new routed path is held during an active meeting exactly like an
  HTTP-originated one, and flushed via the existing `flushHeldBatch` coalesce path.
- `proactive-swap.test.ts` / `reaper-job.test.ts` / `deploy-staleness.test.ts` /
  `data-integrity-scan.test.ts` / `credential-swap-flow.test.ts`: existing `notify` injection seam
  still intercepts calls in tests (no test rewrite needed beyond the new default target).
- `bun test apps/agent/src/notifications apps/agent/src/services` green.

## Done Means
- A credential-headroom ladder notification (or reaper-job / deploy-staleness / data-integrity-scan
  / credential-swap-flow notification) fired while a meeting is active is held and coalesced into
  the "N updates while you were in a meeting" summary, exactly like a hook-triggered notification.
- Quiet hours and the rate-throttle setting apply uniformly to these five sources, observably —
  toggling quiet hours on suppresses a 3am ladder notification the same way it suppresses a 3am
  hook notification.
- No behavior change to a notification NOT held/throttled — it still reaches `tts`/`desktop`
  exactly as before, now via the manager instead of a raw bus emit.

## Preconditions
- `apps/agent/src/notifications/manager.ts` exports `NotificationManager` with a `send()` method: `grep -n "async send(" apps/agent/src/notifications/manager.ts` → line 200.
- All five touched services exist and currently bypass the manager: `grep -rn 'lifecycleBus.emit("NotificationFired"' apps/agent/src/services/*.ts` → 5+ hits across the named files.
- `NotificationRow = typeof notifications.$inferSelect` (full DB row shape): `grep -n "NotificationRow" apps/agent/src/notifications/buffer.ts` → confirms `send()`'s parameter shape.

## Scope
- **IN**: a lightweight adapter on `NotificationManager` (e.g. `sendServiceNotification()`) that
  accepts the existing minimal `NotificationFiredPayload` shape (id/title/body/message/channel,
  no `project` required) these 5 services already build, fills in the `NotificationRow` columns
  `send()` needs with sensible defaults (no `project` → never rate-throttled, matching current
  `send()` behavior for project-less rows), and runs the same meeting/presence/quiet-hours gate
  before delivering; redirecting each of the 5 services' `notify` default to call it instead of
  `lifecycleBus.emit` directly.
- **OUT**: `rules-engine.ts` semantics, `routes/notifications-deliver.ts` (a distinct,
  already-gated HTTP entry point), `manager.ts:532`'s own internal deliver call (already
  downstream of gating), the Swift/client-side TTS pipeline (separate proposal
  `tts-pipeline-stop-and-queue`), and `socket-server/dispatcher.ts` (relays an already-routed
  event, not a new emission site).

---
status: draft
after: close-env-doc-and-audit-suppression-drift — same noise-reduction audit batch, no shared files, ordered for triage convenience only
---

# Proposal: Wall-clock quiet-hours gate for non-critical TTS on the presence-unknown path (plan 042)

## Change ID
`add-notification-quiet-hours-gate`

## Summary
Add a hard wall-clock quiet-hours gate (default midnight-7am) that downgrades non-critical
`tts` notifications to `desktop` when no presence signal exists at all — the legacy delivery
path that currently has zero time-of-day awareness and fires 20-31 TTS notifications/hour
through the night on a machine with no bound Mac/phone presence sensor.

## Context
- Depends on: `plans/041-rate-throttle-repeat-tts-notifications.md` (shared `NotificationManager` constructor insertion point in `manager.ts` — this change adds the 6th positional parameter after plan 041's `rateThrottle` 5th; plan 041 is already DONE on `main`, unpushed, per `plans/README.md`)
- Related: `plans/042-quiet-hours-gate-legacy-notification-path.md` — fully detailed executor plan, converted here into a tracked openspec batch
- touches: `packages/db/src/schema/notificationSettings.ts`, `apps/agent/src/routes/notification-settings.ts`, `apps/agent/src/notifications/quiet-hours.ts`, `apps/agent/src/notifications/manager.ts`, `apps/agent/src/routes/notifications.ts`

## Motivation
A 2026-07-13 noise-reduction audit found TTS fires all night (26, 28, 22, 24, 18, 27, 31
notifications for hours 00-06 on 2026-07-12) whenever `decidePresenceRoute()` falls back to
the legacy path — which happens when presence-aware routing is off, or the presence vector has
zero known fields (a headless/background agent with no bound Mac or phone sensor, common for
autonomous CC sessions). This is NOT a bug in the presence-aware rules engine itself — Rule 1
("an active Mac beats bedtime") is an intentional, already-confirmed tradeoff and is untouched
by this change. The gap is specifically the legacy path's total absence of time-of-day
awareness. Leo's explicit decision: gate non-critical TTS only; `priority: "high"`
notifications (crash-stop, permission-request, hook-failure, api-error) always fire
immediately regardless of time or presence state.

## Requirements

### Requirement: Non-critical TTS on the presence-unknown path SHALL respect a configurable quiet-hours window
`NotificationManager` MUST downgrade a `channel: "tts"` notification to `channel: "desktop"`
when `decidePresenceRoute()` returns `null` (presence-aware routing disabled, or the presence
vector has zero known fields) AND the current wall-clock hour falls within the configured
`[quietHoursStartHour, quietHoursEndHour)` window (supporting a window that wraps past
midnight) AND `quietHoursEnabled` is true. This check MUST run at both legacy delivery points:
`send()`'s immediate-delivery branch and `flush()`'s buffered-queue delivery. A
`priority: "high"` notification MUST NEVER be downgraded, regardless of the window. The
presence-aware rules engine's own Rule 1 (active-Mac-beats-bedtime) and Rule 3
(phone-reported bedtime) are unaffected — this gate is a floor for when no presence signal
exists at all, not a replacement for either rule.

#### Scenario: Non-critical TTS inside the quiet-hours window with no presence signal is downgraded

- **GIVEN** `quietHoursEnabled=true`, `quietHoursStartHour=0`, `quietHoursEndHour=7`
- **AND** the current wall-clock hour is 3
- **AND** presence-aware routing returns `null` (no known presence signal)
- **WHEN** a `channel: "tts"`, `priority` other than `"high"` notification is sent via the
  legacy delivery path
- **THEN** the notification is delivered with `channel: "desktop"` instead of `"tts"`

#### Scenario: A critical notification is never downgraded

- **GIVEN** the current wall-clock hour is within the configured quiet-hours window
- **WHEN** a `priority: "high"` notification (e.g. crash-stop, api-error) is sent via the
  legacy delivery path
- **THEN** the notification is still delivered with `channel: "tts"` unchanged

#### Scenario: Quiet hours disabled or unconfigured leaves legacy behavior unchanged

- **GIVEN** `quietHoursEnabled=false`, or `NotificationManager` was constructed with no
  `quietHours` wiring at all
- **WHEN** a non-critical `tts` notification is sent via the legacy delivery path at any hour
- **THEN** the notification is still delivered with `channel: "tts"` unchanged

#### Scenario: The quiet-hours window is operator-configurable via the settings route

- **GIVEN** a `PATCH /notifications/settings` request with body
  `{"quiet_hours_start_hour": 23, "quiet_hours_end_hour": 6}`
- **WHEN** the request is processed
- **THEN** the response reflects the updated window
- **AND** subsequent legacy-path deliveries use the new window

## Scope
- **IN**: `notificationSettings` schema (+3 columns), its migration, `notification-settings.ts`
  route (allow-list/validation/response), the new pure `quiet-hours.ts` helper,
  `NotificationManager`'s `QuietHoursWiring` + `applyQuietHoursIfNeeded()` + its 2 call sites,
  `notifications.ts`'s settings reader wiring
- **OUT**: `rules-engine.ts` Rule 1 and Rule 3 (intentional, unmodified), `flushHeldBatch()`'s
  own bedtime-silence check, plan 041's rate-throttle check (kept independently readable, not
  merged), Swift dashboard UI for the new settings

## Testing
| Affected seam | Unit task | E2E task |
|----------------|-----------|----------|
| `isWithinQuietHours()` pure helper | [4.1] 7 boundary/wrap/zero-width tests | N/A — pure function, no user-facing flow |
| `NotificationManager.applyQuietHoursIfNeeded()` | [4.2] 5 tests (disabled/enabled-inside/enabled-outside/critical-exempt/no-wiring) | N/A — covered by unit tests |
| `notification-settings.ts` route | [4.3] 3 new PATCH validation/persistence tests | N/A — existing route test file covers this surface |

## Impact
| Area | Change |
|------|--------|
| `packages/db/src/schema/notificationSettings.ts` | +3 columns (`quietHoursEnabled`, `quietHoursStartHour`, `quietHoursEndHour`) |
| `packages/db/drizzle/*.sql` | +1 migration (3 `ALTER TABLE ADD COLUMN`) |
| `apps/agent/src/notifications/quiet-hours.ts` | new file, pure helper |
| `apps/agent/src/notifications/manager.ts` | +interface, +constructor param, +private method, 2 call sites |
| `apps/agent/src/routes/notification-settings.ts` | +3 allow-listed fields |
| `apps/agent/src/routes/notifications.ts` | +settings reader, +6th constructor arg |

## Risks
| Risk | Mitigation |
|------|-----------|
| Changes when TTS delivers for the "no presence signal" case | Explicit Leo-confirmed policy decision; settings-driven enable/disable toggle; never touches `priority: "high"` |
| Depends on plan 041's constructor slot | Sequencing documented; if 041 hasn't landed, insert as the 5th positional param instead of 6th (see plan 042 STOP conditions) |

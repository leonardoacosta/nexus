<!-- beads:epic:nx-09shh -->
<!-- beads:feature:nx-wo5cl -->

# Implementation Tasks

## DB Batch

- [x] [1.1] Add 3 columns to `notificationSettings` schema (`quietHoursEnabled` bool default true, `quietHoursStartHour`/`quietHoursEndHour` integers default 0/7) after plan 041's rate-throttle columns, per plans/042-quiet-hours-gate-legacy-notification-path.md Step 1 [owner:db-engineer] [type:db] [beads:nx-wmhes]
- [x] [1.2] Generate migration via `pnpm --filter @nexus/db db:generate` (exactly 3 `ALTER TABLE ADD COLUMN` statements); never `db:push` [owner:db-engineer] [type:db] [beads:nx-oq6ku]

## API Batch

- [ ] [2.1] Create pure helper `apps/agent/src/notifications/quiet-hours.ts` exporting `isWithinQuietHours(startHour, endHour, now)`, supporting a midnight-wrapping window and treating a zero-width window as disabled, per Step 3 [owner:api-engineer] [type:api] [beads:nx-j4k4k]
- [ ] [2.2] Extend `apps/agent/src/routes/notification-settings.ts`: add `quiet_hours_enabled`/`quiet_hours_start_hour`/`quiet_hours_end_hour` to `ALLOWED_KEYS`, `SettingsResponse`/`SettingsRow`, `toResponse()`, per-field validation (boolean for enabled; integer 0-23 for the two hour fields), and the `changed` check, mirroring plan 041's Step 3 pattern [owner:api-engineer] [type:api] [beads:nx-mbszu]
- [ ] [2.3] Add `QuietHoursWiring`/`QuietHoursSettings` interfaces, a `private quietHours` field, a 6th constructor parameter (after plan 041's `rateThrottle`), and the private `applyQuietHoursIfNeeded()` method to `apps/agent/src/notifications/manager.ts`; call it at both legacy delivery points (`send()` immediate-delivery branch, `flush()`'s queued-delivery map), per Step 7 [owner:api-engineer] [type:api] [beads:nx-hwq6c]
- [ ] [2.4] Add `readQuietHoursSettings()` to `apps/agent/src/routes/notifications.ts` and wire it as the 6th `NotificationManager` constructor argument in `initNotificationRoutes`, per Step 9 [owner:api-engineer] [type:api] [beads:nx-t8w9v]

## E2E Batch

- [ ] [4.1] Unit tests for `isWithinQuietHours()`: non-wrapping inside/outside (end exclusive), wrapping inside at both boundaries, zero-width-disabled — 7 cases per Step 4 [owner:tdd-integration] [type:testing] [beads:nx-vniq2]
- [ ] [4.2] `manager-quiet-hours.test.ts`: disabled-no-downgrade, enabled+inside-current-hour-window (compute `h = now.getHours()`, use `{startHour: h, endHour: (h+1)%24}` for determinism), enabled+outside, `priority:"high"` never downgraded, no-wiring-byte-identical — 5 cases per Step 8 [owner:tdd-integration] [type:testing] [beads:nx-dg6bj]
- [ ] [4.3] 3 new `notification-settings.test.ts` cases (GET default, PATCH rejects out-of-range hour, PATCH persists valid window) per Step 6; full regression `bun test apps/agent/src/notifications/` all pass [owner:e2e-engineer] [type:testing] [beads:nx-qxh5b]

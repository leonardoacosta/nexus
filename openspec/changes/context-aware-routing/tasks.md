<!-- beads:epic:nx-i4sp1 -->
<!-- beads:feature:nx-du7ah -->

# Tasks — Context-Aware Notification Routing (Phase 1)

## DB Batch

- [x] Add `presence_holds` table in `packages/db/src/schema/presenceHolds.ts` (id, user_id, payload jsonb, hold_until timestamptz, reason text, created_at, released_at nullable) with `$inferSelect`/`$inferInsert` exports [beads:nx-eu2rv]
- [x] Add `routing_rules` table in `packages/db/src/schema/routingRules.ts` (id, user_id, priority int, condition jsonb, action jsonb, enabled bool default true, updated_at) with an index on (user_id, priority) [beads:nx-y1yce]
- [x] Add `presence_aware_routing` (bool, default false), `unknown_noncritical_mode` (text `$type<"fail-safe"|"fail-open">`, default `fail-safe`), `unknown_critical_mode` (text `$type<"fail-open"|"fail-safe">`, default `fail-open`) columns to `packages/db/src/schema/notificationSettings.ts` [beads:nx-bzkci]
- [x] Export the two new tables (+ types) from `packages/db/src/schema/index.ts` [beads:nx-2krna]
- [x] Run `pnpm --filter @nexus/db db:push` against `POSTGRES_URL` and verify the new columns/tables exist (no hand-written `.ts` migration) [beads:nx-k8tal]

## API Batch

- [x] Add `PresenceField<T>`, `Confidence`, `Source`, and `PresenceVector` (Phase 1 fields: macActive, macLocked, macHost, inMeeting, meetingEndsAt, isBedtime) to `packages/core/src/types/presence.ts` [beads:nx-3zluj]
- [x] Add the closed `Action` interface (banner, ding, tts, deliverTo, deliveryMode, interruptionLevel, collapseId, stopPropagation, holdUntil, digest, redact) and extend `NotificationRule` with `condition`/`action` in `packages/core/src/types/notification.ts` [beads:nx-m86ir]
- [x] Implement the `presence-context.ts` singleton in `apps/agent/src/notifications/presence-context.ts` — per-user vector, per-field TTL (mac ~30s), merge-on-report, `unknown`-past-TTL reads, emits `PresenceChanged`; feed `inMeeting` from the existing meeting-state [beads:nx-bbbu8]
- [x] Implement the rules engine in `apps/agent/src/notifications/rules-engine.ts` — priority-ordered first-match-wins producing an `Action`; ship Rule 1 (active Mac, not in meeting -> banner+tts to macHost, beats bedtime) and Rule 2 (in meeting -> hold); terminal fallback to dashboard+digest; staleness policy (fail-safe non-critical, fail-open critical) [beads:nx-jj41k]
- [x] Wire `apps/agent/src/notifications/router.ts` to call the rules engine; gate on `presence_aware_routing` and return the legacy project/`meeting_behavior` result when disabled (byte-identical fallback) [beads:nx-8042w]
- [x] Implement `apps/agent/src/notifications/held-queue.ts` — DB-backed read/write to `presence_holds`, reload pending holds on boot, schedule flush at `holdUntil`, mark released + emit `PresenceHoldReleased`; remove the in-memory buffer path [beads:nx-kvby7]
- [x] Update `apps/agent/src/notifications/manager.ts` to route through the presence-hold path, coalesce a held batch into one summary on flush, and apply the bedtime+idle silent guard [beads:nx-3hmy9]
- [x] Add `PresenceChanged` and `PresenceHoldReleased` to `LifecycleEventMap` in `apps/agent/src/services/lifecycle-bus.ts` (with payload interfaces) [beads:nx-etrke]
- [x] Add `POST /presence/report` handler in `apps/agent/src/routes/presence-report.ts` — validate body, merge into the vector, 400 on bad shape; register the route on the agent server [beads:nx-ep9al]
- [x] Extend `apps/agent/src/routes/notification-settings.ts` to accept the three new settings keys and CRUD `routing_rules` (ordered), broadcasting `SettingsChanged` [beads:nx-t605y]

## UI Batch

- [ ] Extend `apps/swift/NexusShared/Storage/SettingsStore.swift` with the routing payload model (presence-source toggles, fail modes, ordered rules) and PATCH/SSE sync through the existing settings path [beads:nx-rwulm]
- [ ] Create `apps/swift/nexus-mac/Sources/Dashboard/Settings/SettingsRoutingView.swift` — presence-source toggles, unknown-presence fail-mode picker, editable/reorderable rules list, and a what-wins simulator [beads:nx-tis8m]
- [ ] Register the `Routing` tab as a new enum case in `apps/swift/nexus-mac/Sources/Dashboard/SettingsView.swift` [beads:nx-g2yws]

## E2E Batch

- [x] `apps/agent/src/notifications/presence-context.test.ts` — field merge, TTL -> unknown, `PresenceChanged` emission, meeting-state -> inMeeting [beads:nx-ukdgx]
- [x] `apps/agent/src/notifications/rules-engine.test.ts` — first-match-wins, Rule 1 active-Mac (incl. active-at-night beats bedtime), Rule 2 meeting-hold with AND-gate + 60m cap, flag-off legacy parity, terminal fallback [beads:nx-p6u1v]
- [x] `apps/agent/src/notifications/held-queue.test.ts` — persist, restart reload, flush at holdUntil, released marker + `PresenceHoldReleased` [beads:nx-9631m]
- [x] `apps/agent/src/routes/presence-report.test.ts` — valid merge, invalid-shape 400, vector reflects report [beads:nx-s04l8]
- [x] Extend `apps/agent/src/routes/notification-settings.test.ts` — new keys accepted + validated, rule reorder persists, `SettingsChanged` broadcast, no-op short-circuit [beads:nx-d9lfj]
- [ ] `apps/swift/nexus-mac/Tests/SettingsRoutingViewTests.swift` — simulator selects the correct winning rule; toggle persists through SettingsStore [beads:nx-dimqx]

# Design — Context-Aware Notification Routing (Phase 1)

## Context

Extends the existing notification spine (`apps/agent/src/notifications/*`) without disturbing the
default path. The presence layer is additive and gated by `presence_aware_routing` (default off),
so existing single-toggle meeting behavior is unchanged until a user opts in.

Reference: `docs/diagrams/presence-routing-research.html` (full signal catalog, presence vector,
rules engine, locked Q1–Q6 decisions).

## Goals / Non-Goals

**Goals**
- A per-user presence vector the agent holds, fed by a thin ingest endpoint + existing meeting-state.
- A priority rules engine (first-match-wins) producing a closed `Action`.
- Rules 1 (active-Mac TTS) and 2 (meeting-hold) shipping; durable hold queue.
- A Mac `Routing` settings tab with an editable rules list + simulator.

**Non-Goals (later phases)**
- Mac `PresenceObserver` reading idle/lock/camera/mic/Focus directly (Phase 1.5).
- Agent-side Tailscale home detection + iOS reporting (Phase 1.5 / 2).
- Watch delivery, escalation ladder, Rule 0 critical, severity model (Phase 3).
- Rate/digest/redaction policy surface (Phase 4).

## Key Decisions

### Presence ingest via a thin endpoint, not a new observer
Phase 1 ships `POST /presence/report` so any reporter (a future observer, a CLI poller, or a test)
can push `macActive`/`macLocked`/`macHost`/`inMeeting`. The existing meeting-state also feeds
`inMeeting`. This proves the engine end-to-end (testable by POSTing states) while deferring the
real Mac observer to Phase 1.5. Rationale: smallest valuable slice; the riskiest detection work
(CMIO camera listener, Focus-DB parser) is isolated to a later phase.

### Rules engine replaces `findMatchingRule`, gated by a flag
`rules-engine.ts` holds the priority list + `Action` shape. `router.ts` calls it; when
`presence_aware_routing` is false it returns the legacy project/`meeting_behavior` result so
`routeNotificationParallel` is unchanged. No public contract churn — `NotificationChannel` stays
`desktop | tts` this phase (watch/phone are later).

### Durable hold queue replaces the in-memory buffer
`held-queue.ts` reads/writes a `presence_holds` table (id, notification payload, holdUntil,
reason, releasedAt). On boot the agent reloads pending holds and schedules flushes. This fixes the
`meeting-state.ts` + `buffer.ts` restart-data-loss bug. The old in-memory buffer is removed, not
kept in parallel (breaking the internal buffer contract — no public API affected).

### Rules persisted in a table, settings extended on the sentinel row
`routing_rules` (ordered) keeps drag-reorder priority durable and queryable. The single-row
`notification_settings` gains three columns. Both reuse the existing `SettingsChanged` broadcast —
no new SSE channel.

## Data Model

```text
presence_holds        (NEW)   id, user_id, payload(jsonb), hold_until, reason, created_at, released_at
routing_rules         (NEW)   id, user_id, priority(int), condition(jsonb), action(jsonb), enabled, updated_at
notification_settings (MODIFY) + presence_aware_routing(bool=false)
                              + unknown_noncritical_mode(text='fail-safe')
                              + unknown_critical_mode(text='fail-open')
```

Migration via `pnpm --filter @nexus/db db:push` (drizzle-kit), per the project's canonical Postgres
target. No hand-written `.ts` migration.

## Lifecycle Events

Add to `LifecycleEventMap` in `lifecycle-bus.ts`:
- `PresenceChanged` — emitted on every vector merge (payload: the updated vector + changed keys).
- `PresenceHoldReleased` — emitted when a held notification flushes.

## Risks / Trade-offs

- **Held-queue migration of in-flight buffer:** on first deploy, any in-memory buffered items are
  lost once (the old buffer is removed). Acceptable — buffered items are transient and the window
  is a single deploy.
- **Swift build gating:** the Mac UI batch depends on a Mac being awake to sign/build (project
  memory: Tier A flake can silently gate auto-deploy). The agent batches (DB/API/E2E) are
  independently testable via `bun test` and do not block on the Swift build.
- **Flag-off parity:** the legacy fallback must produce byte-identical channel results when
  `presence_aware_routing` is off — covered by an E2E parity test.

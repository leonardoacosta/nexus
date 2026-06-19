# Context-Aware Notification Routing — Phase 1

## Why

Today nx routes notifications by **project** plus a single **manual meeting toggle**
(`meeting-state.ts`, an in-memory idle/active flag with a literal `// calendar integration
later` TODO). There is no awareness of where the human actually is, so a notification fires the
same way whether you are at your desk, in a meeting, or asleep.

This phase lays the **spine** for presence-aware routing: a per-user presence vector the agent
holds, a priority-ordered rules engine that consumes it, and a durable hold queue. It ships the
two rules that need no new OS permissions (active-Mac TTS, meeting-hold) and a Mac settings tab
to view/edit them. Later phases add the full Mac observer (1.5), iOS reporting (2), and
watch/escalation (3) — see `docs/diagrams/presence-routing-research.html` for the full design and
the locked Q1–Q6 decisions this phase implements.

A second motivation: the current meeting buffer (`buffer.ts` + `meeting-state.ts`) is **in-memory
only**. Held notifications are lost on every agent restart (systemd reload, post-merge deploy
fan-out, OOM). This phase replaces it with a **DB-backed held queue**, fixing a real data-loss bug
as a side effect of building the presence hold.

## What Changes

- **Presence vector** — a new agent-held `PresenceVector` (per-user, TTL'd fields) populated via
  a thin `POST /presence/report` ingest endpoint and the existing meeting-state. Phase 1 fields:
  `macActive`, `macLocked`, `macHost`, `inMeeting`, `meetingEndsAt`, `isBedtime`. Stale-past-TTL
  fields read `unknown`, never a stale truth.
- **Rules engine** — a priority-ordered, first-match-wins `condition → action` evaluator
  replacing the flat `findMatchingRule`. Ships **Rule 1** (active Mac, not in meeting →
  banner + TTS to the live host) and **Rule 2** (in meeting → hold until 2 min after it ends,
  then a coalesced summary). Rule 0 (critical) is **deferred** until the severity model is
  defined — shipping critical-bypass without a `critical` definition is incoherent (Q4).
- **DB-backed held queue** — held/digested notifications persist in a `presence_holds` table and
  survive agent restart; flush re-evaluates rules (a flush landing inside bedtime + idle Mac
  delivers silent).
- **Routing settings** — `notification_settings` gains presence-routing toggles
  (`presence_aware_routing`, `unknown_noncritical_mode`, `unknown_critical_mode`); rules persist
  in a drag-orderable `routing_rules` table; both broadcast via the existing `SettingsChanged`
  lifecycle event.
- **Mac Routing tab** — a new `SettingsRoutingView` in `nexus-mac` (enum case in `SettingsView`):
  presence-source toggles, the editable rules list, and a what-wins simulator.

**Decisions implemented (locked 2026-06-19):** Q1 active Mac beats bedtime · Q2 AND-gated meeting
detection with adjustable buffer · Q5 home detection deferred to agent-side Tailscale (Phase 1.5,
NOT this phase) · Q6 single-user, fleet-merged. Q3/Q4/Q4b affect later rules.

## Impact

- Affected capability: `context-aware-routing` (new)
- New runtime input path: `POST /presence/report` → `presence-context` singleton → rules engine
- Behavioral change: when `presence_aware_routing` is ON, the router consults the presence vector
  before channel fan-out. When OFF (default until opted in), routing falls back to today's
  project + `meeting_behavior` logic — **no regression for existing users**.
- The in-memory meeting buffer is replaced by the durable hold queue. This is a breaking change to
  the internal buffer contract (not a public API); existing buffered-notification behavior is
  preserved through the new table.

## Context
- depends on:
- touches: `packages/db/src/schema/notificationSettings.ts`, `packages/db/src/schema/presenceHolds.ts`, `packages/db/src/schema/routingRules.ts`, `packages/db/src/schema/index.ts`, `packages/core/src/types/notification.ts`, `packages/core/src/types/presence.ts`, `apps/agent/src/notifications/presence-context.ts`, `apps/agent/src/notifications/rules-engine.ts`, `apps/agent/src/notifications/router.ts`, `apps/agent/src/notifications/manager.ts`, `apps/agent/src/notifications/held-queue.ts`, `apps/agent/src/services/lifecycle-bus.ts`, `apps/agent/src/routes/notification-settings.ts`, `apps/agent/src/routes/presence-report.ts`, `apps/swift/nexus-mac/Sources/Dashboard/Settings/SettingsRoutingView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/SettingsView.swift`, `apps/swift/NexusShared/Storage/SettingsStore.swift`

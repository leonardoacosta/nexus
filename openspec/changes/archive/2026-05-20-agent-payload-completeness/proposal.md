# Proposal: Agent payload completeness for Swift dashboard

## Change ID

agent-payload-completeness

## Phase

Quality hardening — close the agent-under-emits / Swift-decodes-degraded-view
gaps surfaced by `extend-integration-gate-liveness-payloads` PayloadDecodeTests.

## Why

The PayloadDecodeTests shipped 2026-05-19 pin the Swift Codable contract AS IT
EXISTS today — and exposed a deeper class of bug: the agent emits FEWER fields
than the dashboard would benefit from. Each Swift model uses `decodeIfPresent`
defensively, so missing server-side fields fail silently rather than blocking
the decode. The dashboard renders a degraded view (no hidden filter, no spec
status tri-state, no notifications, no traceable failure rows) and no test
catches it because the contract is bidirectionally tolerant.

Four concrete gaps:

1. **`GET /projects.hidden` missing** — the `hidden` column was added to
   `projects` and `project_locations` tables in `folder-based-project-autodiscovery`
   (commit `838913b`). The PATCH endpoint accepts it. The read path doesn't
   surface it. The Swift dashboard can't filter hidden projects without
   round-tripping through PATCH state.

2. **`GET /specs` lacks `has_proposal/has_design/has_tasks` tri-state** —
   spec-watcher emits `name/project/status/completedTasks/totalTasks/lastModified`
   but no signal about which of the 3 markdown artifacts exist. SpecSummary in
   the dashboard would benefit from this for the spec inspector view.

3. **`GET /notifications` endpoint absent** — the agent has
   `/notifications/settings` but no list endpoint. Returns
   `{"error":"not found"}` today. NotificationEvent on the Swift side has
   nothing to fetch.

4. **`/failures.top_errors` lacks per-row `trace_id` + `stack_truncated`** —
   the aggregate response has no traceability hooks; ScriptError must
   fabricate ids client-side.

## What Changes

Agent (TS):

- Add `hidden: boolean` to the `/projects` aggregate response (read from
  registry rows, OR for the unregistered bucket, false).
- Extend spec-watcher's `SpecSnapshot` with `has_proposal/has_design/has_tasks`
  booleans, computed at scan time.
- Add `GET /notifications` returning the canonical NotificationEvent list with
  `severity` + `delivery_state` fields.
- Extend `/failures.top_errors[]` rows with `trace_id` and `stack_truncated`.

Swift (NexusShared):

- `ProjectAggregate.hidden: Bool` (non-optional, default false).
- `SpecSummary.{hasProposal, hasDesign, hasTasks}: Bool` (non-optional,
  default false).
- `NotificationEvent.{severity: NotificationSeverity, deliveryState: DeliveryState}`
  (non-optional).
- `ScriptError.{traceID: String?, stackTruncated: Bool}` (traceID optional
  on legacy rows, stackTruncated defaults false).

Gate (test-infrastructure):

- PayloadDecodeTests v2 — replaces `decodeIfPresent` patterns with required
  Codable for the four newly-pinned fields. Decode failure on an agent that
  fails to emit any one of them blocks the pre-push gate.

## Context

- depends on: `extend-integration-gate-liveness-payloads` (archived 2026-05-19) — that spec
  shipped PayloadDecodeTests v1 which used `decodeIfPresent` everywhere. v2 tightens it.
- touches: `apps/agent/src/routes/projects.ts`, `apps/agent/src/services/spec-watcher/parser.ts`, `apps/agent/src/routes/specs.ts`, `apps/agent/src/routes/notifications.ts`, `apps/agent/src/routes/failures-route.ts`, `apps/agent/src/server-request-handler.ts`, `apps/swift/NexusShared/Models/ProjectAggregate.swift`, `apps/swift/NexusShared/Models/SpecSummary.swift`, `apps/swift/NexusShared/Models/Notification.swift`, `apps/swift/NexusShared/Models/ScriptError.swift`, `apps/swift/NexusSharedTests/PayloadDecodeTests.swift`, `packages/core/src/types/project.ts`, `packages/core/src/types/spec.ts`, `packages/core/src/types/notification.ts`, `packages/core/src/types/failure.ts`

## Motivation

Two failure modes drove this:

- **Operational**: today's dashboard cannot filter hidden projects via list — the user must
  open each project to see if `hidden=true`. This defeats the affordance shipped a week ago.
- **Architectural**: the gate's value proposition ("decode regression aborts the push")
  evaporates when decoders are forgiving. v2 tests pin REQUIRED fields, restoring the gate's
  promise.

## Out of Scope

- New UI for hidden-project filtering (the `hidden` field surface is sufficient — UI follow-up
  is a separate proposal).
- ElevenLabs voice config per project (overlaps with `swift-owns-elevenlabs-synth` already
  shipped).
- Failure row aggregation strategy refactor (per-row trace_id is the minimum needed; full
  schema migration is out of scope).

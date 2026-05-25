# agent-swift-readmodel-fields

## Why

Four agent read-model endpoints and their NexusShared Swift models are missing fields the UI needs. All four are the same shape: add field(s) to the agent JSON endpoint, the matching `packages/core` type, and the Swift model with decoding. Bundling them enforces the contract-sync discipline (agent route ↔ core type ↔ Swift model) once instead of letting each pair drift independently.

## What Changes

Extend each endpoint+model pair so the clients can render richer detail:

- `ScriptError` / `GET /failures` gains `trace_id` + `stack_truncated`.
- `NotificationEvent` / `GET /notifications` gains `severity` + delivery state.
- `SpecSummary` / `GET /specs` gains `hasProposal` / `hasDesign` / `hasTasks` tri-state.
- `ProjectAggregate` / `GET /projects` gains `hidden`.

Each change touches three layers in lockstep: the agent route JSON, the shared core type, and the NexusShared Swift model plus its Codable decoding.

## Context

- depends on: `notification-engine-reliability`, `fix-mac-app-install-staleness`
- touches: `apps/agent/src/routes/failures-route.ts`, `apps/agent/src/routes/notifications.ts`, `apps/agent/src/routes/specs.ts`, `apps/agent/src/routes/projects.ts`, `packages/core/src/types/session.ts`, `apps/swift/NexusShared/Models/ScriptError.swift`, `apps/swift/NexusShared/Models/Notification.swift`, `apps/swift/NexusShared/Models/SpecSummary.swift`, `apps/swift/NexusShared/Models/ProjectAggregate.swift`

## Non-Goals

- No UI layout or view changes — only the data fields and their decoding.
- No new endpoints; only field additions to existing handlers.
- No migration of historical persisted records to backfill the new fields.

# Tasks: agent-payload-completeness

<!-- beads:epic:nx-sk3dc -->
<!-- beads:feature:nx-ikvjr -->

## API Batch

- [x] [1.1] Extend `packages/core/src/types/project.ts` `Project` type with `hidden: boolean` [owner:types-engineer] [type:types] [beads:nx-qprig]
- [x] [1.2] Update `apps/agent/src/routes/projects.ts` `aggregateProjects` to surface `hidden` from registry rows (use the existing `projects.hidden` column); unregistered bucket defaults to false [owner:api-engineer] [type:feature] [beads:nx-fjz9h]
- [x] [1.3] [P-1] Extend `apps/agent/src/services/spec-watcher/parser.ts` `SpecSnapshot` with `has_proposal/has_design/has_tasks` booleans computed at scan time [owner:api-engineer] [type:feature] [beads:nx-drzes]
- [x] [1.4] [P-1] Extend `apps/agent/src/routes/specs.ts` `handleListSpecs` to surface the three marker booleans in the JSON response [owner:api-engineer] [type:feature] [beads:nx-rw6k2]
- [x] [1.5] Add `apps/agent/src/routes/notifications.ts` handler for `GET /notifications` returning the canonical NotificationEvent list with `severity` + `delivery_state` fields [owner:api-engineer] [type:feature] [beads:nx-jutwn]
- [x] [1.6] Wire `GET /notifications` into `apps/agent/src/server-request-handler.ts` route table [owner:api-engineer] [type:feature] [beads:nx-ihshs]
- [x] [1.7] [P-2] Extend `apps/agent/src/routes/failures-route.ts` `top_errors[]` row builder with `trace_id` (read from script_errors.trace_id column or null) and `stack_truncated` boolean [owner:api-engineer] [type:feature] [beads:nx-tvhx8]
- [x] [1.8] Extend `packages/core/src/types/{spec,notification,failure}.ts` with the matching TS shapes [owner:types-engineer] [type:types] [beads:nx-sjljo]
- [x] [1.9] Add per-endpoint contract tests under `apps/agent/src/routes/*.test.ts` asserting the new fields are emitted (one test per endpoint) [owner:api-engineer] [type:test] [beads:nx-wc06n]

## UI Batch

- [x] [2.1] Update `apps/swift/NexusShared/Models/ProjectAggregate.swift` to add `hidden: Bool` as non-optional with `decodeIfPresent ?? false` for backward tolerance [owner:ui-engineer] [type:types] [beads:nx-ctm3d]
- [x] [2.2] [P-1] Update `apps/swift/NexusShared/Models/SpecSummary.swift` with `hasProposal: Bool`, `hasDesign: Bool`, `hasTasks: Bool` (non-optional, snake_case CodingKeys) [owner:ui-engineer] [type:types] [beads:nx-8xe5c]
- [x] [2.3] [P-1] Update `apps/swift/NexusShared/Models/Notification.swift` `NotificationEvent` with `severity: NotificationSeverity` enum + `deliveryState: DeliveryState` enum (both non-optional) [owner:ui-engineer] [type:types] [beads:nx-iej4d]
- [x] [2.4] [P-1] Update `apps/swift/NexusShared/Models/ScriptError.swift` with `traceID: String?` + `stackTruncated: Bool` (default false) [owner:ui-engineer] [type:types] [beads:nx-i9ras]
- [x] [2.5] Rewrite `apps/swift/NexusSharedTests/PayloadDecodeTests.swift` as v2 — replace `decodeIfPresent` patterns with non-optional Codable assertions for the four newly-required field groups [owner:ui-engineer] [type:test] [beads:nx-m6o6a]
- [x] [2.6] Add a "missing-field" negative test per endpoint that asserts the decode FAILS when a required field is absent (proves the gate would catch regressions) [owner:ui-engineer] [type:test] [beads:nx-7yhsn]
- [x] [2.7] Capture canonical fixtures from a live homelab agent via `curl` against the Tailscale IP and inline them as Swift string literals; document the agent commit sha alongside each fixture [owner:ui-engineer] [type:test] [beads:nx-100jc]
- [x] [2.8] Regenerate Xcode project via `cd apps/swift && xcodegen generate` if any file structure changes warrant it [owner:ui-engineer] [type:test] [beads:nx-8wqic]

## E2E Batch

- [ ] [3.1] Smoke push: revert one of the new required field emissions (e.g., drop `hidden` from /projects), confirm the pre-push gate Tier A xcodebuild step blocks with the specific Codable key visible in the failure tail. Revert the smoke regression before completing [owner:devops-engineer] [type:test] [beads:nx-41nxv]
- [ ] [3.2] Update `openspec/specs/test-infrastructure/spec.md` post-archive with the new gate-enforced field guarantees [handled by Phase 4 archive] [owner:devops-engineer] [type:docs] [beads:nx-njlkz]

# Tasks: extend-integration-gate-liveness-payloads

<!-- beads:epic:nx-sk3dc -->
<!-- beads:feature:nx-vkmc3 -->

## API Batch

- [x] [1.1] Extend `HealthMetrics` interface in `packages/core/src/types/health.ts` with `db_ok: boolean`, `last_watcher_tick_ms: number`, `socket_server_listening: boolean` [owner:types-engineer] [type:types] [beads:nx-4ne17]
- [x] [1.2] [P-1] Add `lastTickMs(): number` getter to `processWatcher` in `apps/agent/src/services/process-watcher.ts`, updated at the end of `reconcileOnce` [owner:api-engineer] [type:feature] [beads:nx-e603d]
- [x] [1.3] [P-1] Add `isListening(): boolean` getter to `socketServer` in `apps/agent/src/services/socket-server.ts` [owner:api-engineer] [type:feature] [beads:nx-fyp31]
- [x] [1.4] Add `pingDb(db: Db): Promise<boolean>` helper that runs `select 1` with 1s timeout and returns false on failure [owner:api-engineer] [type:feature] [beads:nx-nesr1]
- [x] [1.5] Extend `handleHealthGet` in `apps/agent/src/server-health-handler.ts` to compose the three new fields with per-field try blocks and documented fallbacks (-1 / false) [owner:api-engineer] [type:feature] [beads:nx-42swg]
- [x] [1.6] Extend `stubbedHealthPayload()` to include the three new fields with reasonable defaults so tests using the stub don't break [owner:api-engineer] [type:test] [beads:nx-rrtx1]
- [x] [1.7] Add `homelab-transport.test.ts` block: liveness assertions on /health response (db_ok true, last_watcher_tick_ms in [0, 5*60_000), socket_server_listening true) [owner:api-engineer] [type:test] [beads:nx-sw9tr]
- [x] [1.8] Add `homelab-transport.test.ts` block: socket-spine `session_start` injection → poll `/sessions` until row appears → assert canonical SessionRow shape → cleanup via `session_end` [owner:api-engineer] [type:test] [beads:nx-agc9f]

## UI Batch

- [ ] [2.1] Update Swift `HealthMetrics` model in `apps/swift/NexusShared/Models/` to include three new fields with safe Codable defaults (false / -1 / false) so existing dashboards survive an older agent's response [owner:ui-engineer] [type:types] [beads:nx-r0hk2]
- [ ] [2.2] Create `apps/swift/NexusSharedTests/PayloadDecodeTests.swift` with one test class and one decoder helper [owner:ui-engineer] [type:test] [beads:nx-a8hqt]
- [ ] [2.3] [P-2] Payload test: `ProjectAggregate` decodes inline JSON fixture, asserts `projectID != nil`, `hidden == false`, `sessionCount > 0` [owner:ui-engineer] [type:test] [beads:nx-6xdas]
- [ ] [2.4] [P-2] Payload test: `CredentialState` decodes inline JSON fixture, asserts at least one provider with expected state enum [owner:ui-engineer] [type:test] [beads:nx-xwult]
- [ ] [2.5] [P-2] Payload test: `SpecMeta` decodes inline JSON fixture, asserts hasProposal/hasDesign/hasTasks tri-state and non-empty capability slug [owner:ui-engineer] [type:test] [beads:nx-zeg2m]
- [ ] [2.6] [P-2] Payload test: `Notification` decodes inline JSON fixture, asserts severity + delivery state decode without error [owner:ui-engineer] [type:test] [beads:nx-179hc]
- [ ] [2.7] [P-2] Payload test: `FailureRecord` decodes inline JSON fixture, asserts trace_id non-nil + stack_truncated boolean [owner:ui-engineer] [type:test] [beads:nx-vkiiz]
- [ ] [2.8] Capture canonical JSON fixtures for the five endpoints from a live homelab agent via `curl` against tailscale IP; commit raw JSON inline in the test file as Swift string literals [owner:ui-engineer] [type:test] [beads:nx-7c6y6]

## E2E Batch

- [ ] [3.1] Verify `deploy/hooks.d/pre-push/01-deploy` Tier A bun-test invocation already exports `NEXUS_HEAVY_TESTS=1` for the new tests (no change expected; this task confirms) [owner:devops-engineer] [type:test] [beads:nx-k31ct]
- [ ] [3.2] Verify `deploy/hooks.d/pre-push/01-deploy` Tier A xcodebuild invocation already runs the `NexusSharedTests` bundle (it does — task confirms the new test class is picked up automatically once the file lands) [owner:devops-engineer] [type:test] [beads:nx-0jrpa]
- [ ] [3.3] Smoke push from this branch: trigger a known regression locally (revert the watcher tick exposure), confirm `git push` blocks at Tier A with the specific test name visible in the failure tail [owner:devops-engineer] [type:test] [beads:nx-y5c37]
- [ ] [3.4] Add a one-line entry to `openspec/specs/test-infrastructure/spec.md` (post-archive) noting that liveness + live-session + payload decoders are now gate-enforced [owner:devops-engineer] [type:docs] [beads:nx-eg5mu]

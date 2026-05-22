# Tasks: specs-tab-start-on-spec

<!-- beads:epic:nx-1w06c -->
<!-- beads:feature:nx-l0v2t -->

## DB Batch

- [x] 1.1 Add `packages/db/src/schema/specSessions.ts` — `spec_sessions` table (id identity, project text, spec_name text, session_id text, created_at timestamptz default now()), with composite index on `(project, spec_name)` and single-column index on `session_id`. Mirror `cronRuns.ts` style. [beads:nx-4jm7r]
- [x] 1.2 Export `specSessions` plus the inferred `SpecSession` and `NewSpecSession` types from `packages/db/src/schema/index.ts` (append-only) and the root `packages/db/src/index.ts`. [beads:nx-yctiq]
- [x] 1.3 Generated `packages/db/drizzle/0036_add_spec_sessions.sql` via drizzle-kit (renumbered from 0034 — slots 0034/0035 were taken by 0034_add_credential_usage_columns + 0035_add_notification_audio_and_project_voices before this wave landed). Auto-output already contained only the new table + 2 indices; no trim required. [beads:nx-uqvc8]
- [x] 1.4 Added a 365-day retention rule for `spec_sessions` in `apps/agent/src/db/retention.ts` (this is historical lookup data — longer than `cron_runs`' 90 days). Confirmed the retention runner picks it up via the new `SPEC_SESSIONS_RETENTION_DAYS` constant and the `specSessionsDeleted` log key. [beads:nx-ac5v3]
  - id-column type is `integer` (not `text` as suggested in design.md) because `generatedAlwaysAsIdentity()` is only valid on integer columns; matches every other identity table in the repo.

## API Batch

- [x] 2.1 Added `apps/agent/src/services/session-spec-link.ts` exporting `linkSpecToSession` + helper `resolveSpecDir`. Returns `{ linked, error?, specDir? }` (added `specDir` for downstream observability). Resolves live `openspec/changes/<slug>/` then archived `openspec/changes/archive/*-<slug>/`. [beads:nx-nsqmf]
- [x] 2.2 Extended POST /session/start (`apps/agent/src/routes/sessions.ts`) to accept optional `spec_slug`. Calls `linkSpecToSession` AFTER tmux spawn; never rolls back the spawn on link failure; degrades to `spec_linked: false` + `spec_link_error` on response. [beads:nx-e2oqb]
- [x] 2.3 Added `apps/agent/src/routes/specs/handlers-sessions.ts` — joins `spec_sessions` LEFT against `sessions` to derive `active`, orders DESC by `created_at`. 404 on unknown slug. [beads:nx-7h49k]
- [x] 2.4 Registered `GET /specs/:project/:name/sessions` in `apps/agent/src/server-routes-specs.ts` BEFORE the `/specs/:project/:name/:file` catch-all. Threaded `db` into `tryHandleSpecRoute` so DB-dependent routes can reach the registry. [beads:nx-ngywk]
- [x] 2.5 Added `apps/agent/src/routes/specs/handlers-status.ts` — `handlePatchSpecStatus` + `spliceFrontmatter`. ISO-8601 with TZ offset (matches triage convention), atomic write via `.tmp + fs.renameSync`, archived spec → 409, missing proposal.md → 404. [beads:nx-17yob]
- [x] 2.6 Registered `PATCH /specs/:project/:name/status` (same dispatcher); the 409 short-circuit lives inside `handlePatchSpecStatus` so route registration stays uniform. [beads:nx-4z6ht]
- [x] 2.7 Extended `handleGetSpec` to stitch `frontmatter: Record<string, string>` parsed from `proposal.md`. Reads live first, falls back to archive lookup; missing/malformed → `{}`. Keys preserved verbatim. [beads:nx-umkq5]
- [x] 2.8 Added `status_change` transition to `SpecTransitionPayload` (lifecycle bus) + matching `SpecTransitionStatusChangeEvent` wire shape + zod schema in `@nexus/core`. `handlePatchSpecStatus` emits on success; `specs-events.ts payloadToEvent` translates it to the wire frame. [beads:nx-1k56x]
- [x] 2.9 Unit-tested `linkSpecToSession`/`resolveSpecDir` (`apps/agent/src/services/session-spec-link.test.ts`, 9 tests pass). Note: uses a fake-DB shape mirroring the drizzle insert chain — real-PG harness was disproportionate for a 3-field insert; the integration coverage in 2.12 (deferred) is where real-PG belongs. [beads:nx-y2fcz]
- [x] 2.10 Unit-tested PATCH /status handler (`handlers-status.test.ts`, 10 tests pass) — draft→approved, approved→draft, invalid status, archived 409, missing proposal.md 404, malformed JSON, plus 3 splice-frontmatter direct tests. Real-FS scratch dirs via `os.tmpdir()`. [beads:nx-jhhfd]
- [x] 2.11 Unit-tested GET /sessions handler (`handlers-sessions.test.ts`, 3 tests pass) — 404 unknown spec, empty list, one-active+one-historical with DESC ordering. [beads:nx-8s9wv]
- [ ] 2.12 [deferred] Integration test gated behind `NEXUS_RUN_LIVE_E2E_TESTS=1` — requires live agent + real PG; defer per /apply E2E rule (the rest of the contract is exercised by the unit suites above). [beads:nx-j3e8m]

## UI Batch

- [ ] 3.1 Add `apps/swift/NexusShared/Models/SpecSession.swift` — Codable mirror of the GET /sessions row (`id`, `session_id`, `created_at`, `active`). Cross-platform (no AppKit imports). [beads:nx-8nxya]
- [ ] 3.2 Extend `apps/swift/NexusShared/Models/SpecSummary.swift` with `frontmatter: [String: String]?` (optional for back-compat with older agent responses). [beads:nx-kuqm3]
- [ ] 3.3 Extend `apps/swift/NexusShared/Networking/NexusClient.swift` with three methods: `startSession(project:path:specSlug:)`, `listSpecSessions(project:name:)`, `patchSpecStatus(project:name:status:)`. Each returns Decodable types and follows the existing error-throwing convention. [beads:nx-2ucic]
- [ ] 3.4 Extend `apps/swift/NexusShared/Networking/NexusAggregateClient.swift` with the same three methods, fanned out across configured agents like the existing fan-out pattern. `startSession` requires a single agent (the one owning the project path) — error if ambiguous. [beads:nx-talln]
- [ ] 3.5 In `apps/swift/nexus-mac/Sources/Dashboard/SpecsView.swift`, introduce a `RightPaneState` enum (`.spec(SpecSummary)` / `.pty(sessionId: String, fromSpec: SpecSummary)` / `.empty`). The view body switches on this enum — `.spec` renders SpecDetailView, `.pty` renders PtyViewer (the existing one from Sessions tab). [beads:nx-uimwf]
- [ ] 3.6 Add a "Start Session" button to each proposal row in SpecsView. Disabled when `spec_sessions` already has ≥1 active row for this spec; tooltip lists the existing session IDs. Click handler is async: optimistic transition to `.pty(starting...)`, then real `NexusClient.startSession` call, then replace with real sessionId or revert to `.spec` + error banner on failure. [beads:nx-tmxa5]
- [ ] 3.7 Add an SSE subscriber in SpecsView that listens for `SpecTransition { kind: "status_change" }` events on `/specs/events` and updates the row's status pill optimistically. [beads:nx-i5wmo]
- [ ] 3.8 In `apps/swift/nexus-mac/Sources/Dashboard/SpecDetailView.swift`, add a status pill button at the top: gray for draft, green for approved, blue for archived (read-only). Click → confirm dialog → `NexusClient.patchSpecStatus`. On 409, the button is disabled. [beads:nx-g8h15]
- [ ] 3.9 Add a metadata pane below the status pill in SpecDetailView rendering `frontmatter: [String: String]` as a key/value list (keys monospace left, values monospace right). Skip the `status` key (already shown in the pill). [beads:nx-4eyed]
- [ ] 3.10 Add SpecsViewTests covering the RightPaneState transitions (spec→pty→spec, optimistic-then-error revert) and SSE status_change reconciliation. Mirror SessionRowTests conventions. [beads:nx-ipynm]
- [ ] 3.11 Add SpecDetailViewTests covering the status pill (each transition + archived 409 + frontmatter rendering). Use the existing NexusClient fake. [beads:nx-93hgg]

## E2E Batch

- [ ] 4.1 End-to-end: launch the agent, POST /session/start with spec_slug, assert tmux window exists, assert spec_sessions row inserted, GET /specs/.../sessions returns it with `active: true`. Then tmux kill-session, assert next GET returns `active: false`. [beads:nx-xitnu]
- [ ] 4.2 End-to-end: PATCH /specs/.../status to flip draft→approved on a fixture spec, assert proposal.md frontmatter on disk has all three keys with correct values, assert SSE subscriber receives the transition event. [beads:nx-5hypi]
- [ ] 4.3 [deferred] XCUITest extension to `nexus-mac-UITests` exercising the Start Session button → PTY pane swap. Deferred until the pre-existing SessionsView mount regression (nx-bug filed during apply-2026-05-21-001) is fixed; otherwise this test would silently inherit fault #4. [beads:nx-s34pw]
- [ ] 4.4 Confirm the existing Next.js Projects page "Start Session" button is unaffected by the POST /session/start extension (backwards compatibility — no spec_slug means no link). [beads:nx-h9cpy]

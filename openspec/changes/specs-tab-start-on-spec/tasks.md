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

- [ ] 2.1 Add `apps/agent/src/services/session-spec-link.ts` exporting `linkSpecToSession({ db, project, specSlug, sessionId })` returning `{ linked: boolean, error?: string }`. Resolves spec dir at `openspec/changes/<slug>/` first, then `openspec/changes/archive/*-<slug>/`. On miss, returns `{ linked: false, error: "spec not found" }`. [beads:nx-nsqmf]
- [ ] 2.2 Extend the POST /session/start handler (find via `apps/agent/src/server-request-handler.ts` routing) to accept optional `spec_slug: string`. After successful tmux spawn, call `linkSpecToSession`. Errors in linking MUST NOT roll back the spawn — log via pino and degrade gracefully. Response shape: `{ session_name, started, spec_linked?, spec_link_error? }`. [beads:nx-e2oqb]
- [ ] 2.3 Add `apps/agent/src/routes/specs/handlers-sessions.ts` — handler for `GET /specs/:project/:name/sessions`. Joins `spec_sessions` left-on `sessions` to derive `active`. Orders DESC by `created_at`. Returns `{ sessions: [{ id, session_id, created_at, active }] }` or `404 { error: "spec not found" }` if neither active nor archived dir exists. [beads:nx-7h49k]
- [ ] 2.4 Register the route in `apps/agent/src/server-routes-specs.ts` BEFORE the catch-all `/specs/:project/:name/:file` matcher. Mirror the `commands-send-text` ordering precedent. [beads:nx-ngywk]
- [ ] 2.5 Add `apps/agent/src/routes/specs/handlers-status.ts` — handler for `PATCH /specs/:project/:name/status`. Body schema: `{ status: "draft" | "approved" }`. Resolves user email via `git config user.email` (subprocess), falls back to `$USER`, then `"unknown"`. Atomic write via `.tmp + fs.renameSync`. On approved, write `approved-by` + `approved-at` (ISO-8601 with TZ offset). On draft, remove both keys. Reuses the splice-frontmatter logic from `~/.claude/scripts/bin/triage` (translate to TS). [beads:nx-17yob]
- [ ] 2.6 Register the PATCH route in `apps/agent/src/server-routes-specs.ts` and add a 409 short-circuit for any spec resolved to `openspec/changes/archive/`. [beads:nx-4z6ht]
- [ ] 2.7 Extend `apps/agent/src/routes/specs.ts handleGetSpec` to include `frontmatter: Record<string, string>` parsed from the YAML block of `proposal.md`. Missing frontmatter → `{}`. Preserve keys verbatim (no case normalisation). [beads:nx-umkq5]
- [ ] 2.8 Emit a `SpecTransition` event on the `/specs/events` SSE bus after every successful PATCH /status. Kind: `status_change`, payload includes `{ project, name, to }`. Wire into `apps/agent/src/routes/specs-events.ts`'s existing bus. [beads:nx-1k56x]
- [ ] 2.9 Unit-test `linkSpecToSession`: happy path inserts row; unknown slug returns error; archived slug also links successfully (archives are valid targets). Real PG scratch schema, no mocks. [beads:nx-y2fcz]
- [ ] 2.10 Unit-test the PATCH /status handler: each scenario from `specs/spec-page-live/spec.md` (draft→approved with timestamps, approved→draft removes keys, invalid status 400, archived 409). Use `os.tmpdir()` scratch proposal files; assert via `readFileSync` after each call. [beads:nx-jhhfd]
- [ ] 2.11 Unit-test the GET /sessions handler: empty list, one-active-one-historical, unknown spec 404. Seed `spec_sessions` rows + `sessions` rows in fixture setup. [beads:nx-8s9wv]
- [ ] 2.12 Integration-test the POST /session/start spec linkage: spawn the agent locally, POST with spec_slug, GET /specs/:p/:n/sessions returns the row. Gated behind `NEXUS_RUN_LIVE_E2E_TESTS=1` per project test convention. (This task is in API batch because it's an HTTP-level integration test, not Playwright.) [beads:nx-j3e8m]

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

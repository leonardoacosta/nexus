---
status: approved
approved-by: leo@leonardoacosta.dev
approved-at: 2026-04-27T02:09:13-05:00
---
# Proposal: Apply 4 Findings

## Change ID
`apply-4-findings`

## Summary
Resolve four findings surfaced during the agent-version-handshake and drop-attach-secret-gate applies: (1) wire missing `/notifications/settings` dispatch, (2) delete the dead typed-table router scaffolding (`createRouter`, `RouterOptions`, `Route.requiresAuth`, all `*-builder.ts` files, `routes.ts` orchestrator), (3) wire `startPeerConnector` into agent boot, (4) clean up local `apps/agent/dist/` artifacts and add a build-time guard to prevent recurrence.

## Context
- Extends: `apps/agent/src/server-request-handler.ts` (legacy if/else dispatcher — gains the missing handler), `apps/agent/src/router.ts` (delete most of it), `apps/agent/src/routes.ts` (delete), `apps/agent/src/routes/*-builder.ts` (delete), `apps/agent/src/index.ts` (call `startPeerConnector`), `apps/agent/src/services/peer-connector.ts` (wire callers), `deploy/hooks.d/post-merge/02-deploy` (add stale-dist guard)
- Related: `agent-version-handshake` (archived 2026-04-27 — wired `/version` directly into the if/else, surfaced the dispatcher mismatch); `drop-attach-secret-gate` (archived 2026-04-27 — removed `requireSecret` and `requiresAuth`-driven auth, made the typed table even more obviously dead); follow-ups `nx-mc97r` (P1 bug from finding 1) and `nx-tw3vp` (P3 dispatcher migration — superseded by this proposal's Path X choice)

## Motivation
Two recent applies surfaced concrete problems with the agent's "two parallel route systems" architecture:

- **Finding 1 (P1):** `/notifications/settings` GET + PATCH was registered in `routes/notifications-builder.ts` as part of `add-notification-control-dashboard`, but the actual dispatcher is the if/else chain in `server-request-handler.ts` — which never got the matching `if (url.pathname === "/notifications/settings")` block. Every binary built from main returns 404 on those routes. The dashboard's `agent-version-handshake` reachability classifier surfaces this as "stale-binary" — accurate but pointing at the wrong remediation (rebuild won't help; the source is missing).

- **Finding 2 (cleanup):** The typed route table (`router.ts:createRouter`, `routes.ts:buildRoutes`, every `*-builder.ts`) was a half-finished migration target. With `drop-attach-secret-gate`'s removal of `Route.requiresAuth`-gated auth, the table now has zero behavioral dependents. Keeping it adds drift risk — every new endpoint registered there but not in `server-request-handler.ts` becomes the next finding 1.

- **Finding 3 (latent):** `startPeerConnector` in `services/peer-connector.ts` is exported but never called. It implements an inter-agent federation mesh (peer-to-peer push of notifications, session events) that's wired but unmounted. Either commit to it or delete it; right now it's documentation-by-omission.

- **Finding 4 (cruft):** `apps/agent/dist/` is gitignored but exists locally with 3.2MB of stale compiled `*.test.js` from an earlier `tsc` invocation. The compiled tests reference exports that no longer exist in `@nexus/core` (`safeSpawn`, `logger`, `createLogger`, `expandTilde`, `parseConfig`), which produces ~145 noisy failures when the full agent test suite runs. Pure local-machine cruft, but it pollutes test runs and disguises real failures.

The user's strategic call (asked during /feature discovery): **Path X** for findings 1+2 — wire the missing dispatch into the legacy if/else, then delete the typed-table scaffolding. **Wire** finding 3 (mount `startPeerConnector`). **Delete + gate** finding 4 (rm + post-build sanity check). Aggressive deletion scope: every `*-builder.ts`, plus `router.ts`, plus `routes.ts`. Only `version-builder.ts` and the per-domain handler files survive, because they're called from `server-request-handler.ts` directly.

## Requirements

### Requirement: GET and PATCH /notifications/settings dispatch

The legacy if/else dispatcher in `apps/agent/src/server-request-handler.ts` SHALL match `GET /notifications/settings` and `PATCH /notifications/settings` and call the existing handlers in `apps/agent/src/routes/notification-settings.ts`. The handlers themselves are unchanged — only the dispatch wiring is missing.

#### Scenario: GET /notifications/settings returns 200 with the settings row

- **WHEN** a client sends `GET /notifications/settings` against a freshly-built binary
- **THEN** the response status SHALL be 200
- **AND** the body SHALL contain `tts_enabled`, `banner_enabled`, `ducking_mode` fields per the `NotificationSettingsWire` shape

#### Scenario: PATCH /notifications/settings updates the row and emits SettingsChanged

- **WHEN** a client sends `PATCH /notifications/settings` with `{"tts_enabled": false}`
- **THEN** the response status SHALL be 200
- **AND** the body SHALL reflect the patched value
- **AND** the `SettingsChanged` lifecycle bus event SHALL fire (existing handler behavior — verify by existing test)

#### Scenario: /version capabilities reports both routes

- **WHEN** a client requests `GET /version`
- **THEN** the `capabilities` array SHALL contain BOTH `"GET /notifications/settings"` AND `"PATCH /notifications/settings"`
- **AND** the dashboard's reachability probe SHALL classify this binary as `ok: true` (no longer "stale-binary")

### Requirement: Typed route table scaffolding is deleted

The unused typed-table router scaffolding SHALL be removed. Specifically:

- `apps/agent/src/router.ts` — DELETE entirely. The `Route` type, if still referenced elsewhere, SHALL be inlined into the one or two consumers that need it (likely just `version-builder.ts`).
- `apps/agent/src/routes.ts` — DELETE entirely (the `buildRoutes` orchestrator that wires builders).
- `apps/agent/src/routes/*-builder.ts` — DELETE all per-domain builders EXCEPT `version-builder.ts`, which is still used by `server-request-handler.ts` to compute `/version` capabilities. Files to delete: `health.ts` (the builder, not the handler), `sessions-builder.ts`, `projects-builder.ts`, `health-history-builder.ts`, `notifications-builder.ts`, `credentials-builder.ts`, `analytics-builder.ts`, `operational-builder.ts`, `events-builder.ts`, `project-detail-builder.ts`, `specs-builder.ts`, `commands-builder.ts`, `misc-builder.ts`. (Note: `routes/health.ts` exposes both a handler `handleHealthGet` and a builder `buildHealthRoutes` — keep the handler, drop the builder export.)
- Remove the `requiresAuth` field from any `Route`-shaped object that survives. With `drop-attach-secret-gate` already removing the auth gate, this field has no consumer.

#### Scenario: Build succeeds with deleted files gone

- **WHEN** `cd apps/agent && bun run build` is invoked after the deletions
- **THEN** the build SHALL succeed (no missing imports)
- **AND** the resulting `nexus-agent` binary SHALL serve the same routes it served before (verify by `/version` capability list)

#### Scenario: No remaining references to deleted symbols

- **WHEN** the codebase is searched for `createRouter`, `RouterOptions`, `buildRoutes`, `requiresAuth`
- **THEN** the only matches SHALL be in archived spec deltas
- **AND** there SHALL be NO matches in `apps/agent/src/`

### Requirement: startPeerConnector is mounted at agent boot

The agent's `index.ts` boot sequence SHALL invoke `startPeerConnector` (or its equivalent renamed export) so the peer-to-peer federation channel is live whenever the agent runs. The connector SHALL receive whatever runtime dependencies it needs (DB, agent registry, lifecycle bus) from the existing `AppContext`.

The current `services/peer-connector.ts` was written to forward notifications and session events to other agents in `agents.toml` via direct HTTP/WS. **Investigate the file's intent first** — if the implementation is incomplete or was speculative, the task agent SHOULD pause and surface what's missing rather than mount broken code.

#### Scenario: Connector starts without errors when agents.toml has remote peers

- **GIVEN** `agents.toml` contains at least one peer entry that is NOT this host
- **WHEN** the agent starts
- **THEN** the `startPeerConnector` invocation SHALL complete (no throws, no `process.exit(1)`)
- **AND** the connector SHALL log a clear startup message naming the peers it knows about
- **AND** the peer connection state SHALL be observable (either via log line or a debug endpoint)

#### Scenario: Connector tolerates a peer being offline

- **GIVEN** a peer in `agents.toml` is unreachable
- **WHEN** the connector attempts to dial it
- **THEN** the agent SHALL NOT crash
- **AND** the failure SHALL be logged at warn level
- **AND** the connector SHALL retry (or mark the peer as down — whichever the implementation supports)

#### Scenario: Investigation finding — incomplete implementation

- **WHEN** the api-engineer reads `services/peer-connector.ts` and discovers the implementation is incomplete (missing handlers, TODO markers, dead branches)
- **THEN** the task agent SHALL pause and surface the gap to the orchestrator rather than mounting broken code
- **AND** the orchestrator SHALL decide whether to (a) fill in the gap as part of this spec, (b) defer the wiring to a new spec, or (c) delete the connector entirely (matching the alternative finding-3 option)

### Requirement: apps/agent/dist artifacts are removed and prevented from recurring

The local `apps/agent/dist/` directory SHALL be deleted. The post-merge deploy hook SHALL include a sanity check that warns (not fails) if `apps/agent/dist/` re-appears after a clean `bun run build`, since `bun build --compile` does NOT produce a `dist/` directory — it produces a single `nexus-agent` binary in the package root.

#### Scenario: Local dist directory is gone

- **WHEN** the developer or CI runs `ls apps/agent/dist 2>/dev/null`
- **THEN** the directory SHALL NOT exist
- **AND** `git status` SHALL NOT show it as untracked (it remains gitignored)

#### Scenario: Deploy hook warns on stale dist

- **GIVEN** an operator runs `deploy/hooks.d/post-merge/02-deploy --force`
- **AND** for some reason `apps/agent/dist/` appears after the `bun run build` step
- **THEN** the hook SHALL print a yellow warning naming the unexpected directory
- **AND** SHALL continue with the deploy (the warning is informational, not fatal)

## Scope
- **IN**:
  - Add `GET /notifications/settings` and `PATCH /notifications/settings` blocks to the if/else dispatcher in `server-request-handler.ts`
  - Add both routes to `LEGACY_DISPATCH_ROUTES` so `/version` capabilities reflect them
  - Delete `router.ts`, `routes.ts`, all `*-builder.ts` files except `version-builder.ts`
  - Remove `requiresAuth` field from any surviving Route-shaped objects
  - Investigate and mount `startPeerConnector` in `index.ts`
  - Delete `apps/agent/dist/` locally (rm + verify)
  - Add stale-dist warning to the post-merge deploy hook
  - Update tests touched by deletions (any test that imports from `routes.ts`, `router.ts`, or a deleted `*-builder.ts`)
- **OUT**:
  - Migrating the legacy if/else to a typed table (Path Y rejected; the if/else stays canonical until a future intentional refactor)
  - Replacing the federation peer connector with a different protocol (mTLS, NATS, etc.)
  - Auditing other agent dead code beyond the four findings
  - Touching `apps/nextjs/` or `deploy/nexus-notifier.sh` (already cleaned in prior specs)

## Impact
| Area | Change |
|------|--------|
| `apps/agent/src/server-request-handler.ts` | Add 2 dispatch blocks for GET/PATCH `/notifications/settings`. Add 2 entries to `LEGACY_DISPATCH_ROUTES`. Import the handlers from `routes/notification-settings.ts` |
| `apps/agent/src/router.ts` | DELETE entirely. The `Route` type moves to `version-builder.ts` (or to a new `types.ts` if cleaner) |
| `apps/agent/src/routes.ts` | DELETE entirely. The `buildRoutes` orchestrator becomes dead code with no consumer |
| `apps/agent/src/routes/*-builder.ts` | DELETE 13 files: `health.ts` (builder), `sessions-builder.ts`, `projects-builder.ts`, `health-history-builder.ts`, `notifications-builder.ts`, `credentials-builder.ts`, `analytics-builder.ts`, `operational-builder.ts`, `events-builder.ts`, `project-detail-builder.ts`, `specs-builder.ts`, `commands-builder.ts`, `misc-builder.ts`. Keep `version-builder.ts` |
| `apps/agent/src/routes/health.ts` | Trim to handler only (drop `buildHealthRoutes` export); other per-domain handler files (`notifications.ts`, `credentials.ts`, `notification-settings.ts`, etc.) are unchanged |
| `apps/agent/src/routes/version-builder.ts` | Update import path for `Route` type if it moved |
| `apps/agent/src/index.ts` | Add a `startPeerConnector(ctx)` call in the boot sequence (after DB + watcher are ready, before the HTTP server starts) |
| `apps/agent/src/services/peer-connector.ts` | Possibly add small adjustments after investigation: ensure it accepts the AppContext shape, doesn't fail-fast on no peers, logs cleanly. May be a no-op if already correct |
| `deploy/hooks.d/post-merge/02-deploy` | Add a `[ -d apps/agent/dist ] && warn "stale dist detected"` block after the `bun run build` step |
| `apps/agent/dist/` | Delete the directory locally (one-time cleanup; ignored by git so no commit) |
| Test files | Any test importing from `routes.ts`, `router.ts`, or a deleted builder needs updating. Likely affected: tests under `apps/agent/src/routes/` that imported types from `router.ts` |

## Risks
| Risk | Mitigation |
|------|-----------|
| Deleting `routes.ts` or a `*-builder.ts` breaks an unexpected importer | Run `rg -l '"./routes"\|"./router"\|"-builder"' apps/agent/src/` BEFORE deleting; explicitly enumerate every importer in the deletion task |
| `version-builder.ts` import path for the `Route` type breaks the build | Move the `Route` type to `version-builder.ts` itself (or a small `routes/types.ts`); the type has 4 fields and is trivial to inline |
| `startPeerConnector` has hidden dependencies on the deleted typed table or a `requiresAuth` flag | Investigation step in the task explicitly looks for this; if found, the task pauses and surfaces it to the orchestrator |
| `startPeerConnector` requires HTTP auth via the now-deleted `x-nexus-secret` to talk to remote peers | Remote peers also dropped the gate per `drop-attach-secret-gate`; communication now relies on Tailscale-only network trust. If the connector still injects the header, strip it (similar to consumer cleanup in the previous spec) |
| Stale `apps/agent/dist/` regenerates from a script we don't know about | The investigation in finding 4 includes a one-line check after `bun run build` that lists the agent dir and confirms no `dist/` was produced. If it WAS produced, the task pauses and surfaces the producing command before the warning gate goes in |
| Deletion is large and concurrent with active hook specs (`add-hooks-sse-fanout`, etc.) | The hook specs touch `apps/agent/src/routes/hooks.ts` (handler) and `services/socket-server.ts`, NOT the typed-table scaffolding. Verified via `rg` during discovery — no overlap |

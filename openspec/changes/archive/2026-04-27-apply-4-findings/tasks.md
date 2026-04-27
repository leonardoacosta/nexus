# Implementation Tasks

<!-- beads:epic:nx-zi199 -->
<!-- beads:feature:nx-vtrk2 -->

## DB Batch

- [x] [1.1] [P-1] No schema changes — placeholder retained for /apply batch ordering [owner:db-engineer] [type:db] [beads:nx-91p5n]

## API Batch

- [x] [2.1] [P-1] Add dispatch blocks for `GET /notifications/settings` and `PATCH /notifications/settings` to `apps/agent/src/server-request-handler.ts`; import `handleGetNotificationSettings` and `handlePatchNotificationSettings` from `./routes/notification-settings`; place blocks before the credential-id pre-validation guards [owner:api-engineer] [type:api] [beads:nx-klur8]
- [x] [2.2] [P-1] Add `{method:"GET",path:"/notifications/settings"}` and `{method:"PATCH",path:"/notifications/settings"}` to `LEGACY_DISPATCH_ROUTES` so `/version` capabilities include them [owner:api-engineer] [type:api] [beads:nx-oqk59]
- [x] [2.3] [P-2] Audit every importer of the typed-table scaffolding: `rg -l '"./routes"\|"./router"\|"-builder"' apps/agent/src/` — produce a complete list of files that need surgery before the deletions in 2.4 begin [owner:api-engineer] [type:api] [beads:nx-5vh1a]
- [x] [2.4] [P-2] Move the `Route` type from `apps/agent/src/router.ts` to `apps/agent/src/routes/version-builder.ts` (the only remaining consumer); update `version-builder.ts`'s import and re-export the type if any other file needs it [owner:api-engineer] [type:api] [beads:nx-e8w0t]
- [x] [2.5] [P-3] Delete `apps/agent/src/router.ts` entirely [owner:api-engineer] [type:api] [beads:nx-vdi83]
- [x] [2.6] [P-3] Delete `apps/agent/src/routes.ts` entirely [owner:api-engineer] [type:api] [beads:nx-f0bz2]
- [x] [2.7] [P-3] Delete the 13 `*-builder.ts` files in `apps/agent/src/routes/` (sessions-builder, projects-builder, health-history-builder, notifications-builder, credentials-builder, analytics-builder, operational-builder, events-builder, project-detail-builder, specs-builder, commands-builder, misc-builder; PLUS settings-builder and routes/health.ts — health.ts had no handler exports, the real /health handler lives in server-health-handler.ts) [owner:api-engineer] [type:api] [beads:nx-wv5q2]
- [x] [2.8] [P-3] Strip the `requiresAuth` field from any surviving Route-shaped object — no surviving usage after 2.7 (health.ts deleted; Route type in version-builder.ts already lacks the field per task 2.4) [owner:api-engineer] [type:api] [beads:nx-vdlqv]
- [x] [2.9] [P-4] Investigate `apps/agent/src/services/peer-connector.ts`: read end-to-end, identify required AppContext fields, identify any missing/incomplete handlers; produce a 1-page report with: (a) is it complete enough to mount?, (b) what dependencies does it need from `index.ts`?, (c) are there any surviving `x-nexus-secret` header injections to strip per `drop-attach-secret-gate`? [owner:api-engineer] [type:api] [beads:nx-tmel6]
- [x] [2.10] [P-4] Mount `startPeerConnector` in `apps/agent/src/index.ts` boot sequence (after DB + watcher are ready, before HTTP server starts); pass the AppContext fields the connector needs; ensure failures are logged at warn (not fatal) [owner:api-engineer] [type:api] [beads:nx-0ks0o]
- [x] [2.11] [P-5] Add bun tests covering the new dispatch + boot wiring: `notification-settings` route returns 200/200/PATCH-emit-event, `version` capabilities include both routes, `startPeerConnector` is invoked during boot with empty + populated peer lists [owner:test-writer] [type:testing] [beads:nx-186ur]
- [x] [2.12] [P-5] Update or remove tests that imported from deleted files (router.ts, routes.ts, *-builder.ts) — keep behavior assertions, drop type-only imports, retarget to surviving handler files [owner:test-writer] [type:testing] [beads:nx-897mk]

## UI Batch

- [x] [3.1] [P-1] No UI changes — the dashboard's reachability classifier already detects `/notifications/settings` capability; once the agent dispatches it correctly, the stale-binary banner disappears automatically. Placeholder retained for /apply batch ordering [owner:ui-engineer] [type:ui] [beads:nx-8bwnt]

## E2E Batch

- [x] [4.1] Local cleanup: `rm -rf apps/agent/dist`; verify `apps/agent/dist/` does not regenerate after `cd apps/agent && bun run build`; if it DOES regenerate, pause and report the producing command before continuing [owner:e2e-engineer] [type:config] [beads:nx-hyh5j]
- [x] [4.2] Add a stale-dist warning to `deploy/hooks.d/post-merge/02-deploy` immediately after the `bun run build` step: yellow warning if `apps/agent/dist/` exists, hook continues (informational only) [owner:e2e-engineer] [type:config] [beads:nx-m2b6v]
- [x] [4.3] E2E gate: rebuild homelab agent, restart, then `curl http://127.0.0.1:7400/notifications/settings` (no header → expect 200 with NotificationSettingsWire body), `curl -X PATCH http://127.0.0.1:7400/notifications/settings -d '{"tts_enabled":true}' -H "Content-Type: application/json"` (expect 200 echoing the patched value), and `curl http://127.0.0.1:7400/version | jq '.capabilities[] | select(. == "GET /notifications/settings" or . == "PATCH /notifications/settings")'` (expect both lines printed). Paste all outputs in the apply commit message as runtime evidence [owner:e2e-engineer] [type:testing] [beads:nx-feijb]
- [x] [4.4] Dashboard runtime gate: load `http://localhost:3100/notifications` after the rebuild; the `agent-banner` testid SHALL NOT render (reachability now `ok: true`); the settings controls (tts_enabled toggle, banner_enabled toggle, ducking radio group) SHALL be enabled. Manual gate — paste a screenshot or DOM snippet [owner:e2e-engineer] [type:testing] [beads:nx-aw8jg]
- [x] [4.5] Peer-connector smoke test: with both homelab and macbook agents running the new binary, trigger a notification on homelab and verify the macbook agent receives it via the federation channel (NOT via the existing Mac-listener socket, which already worked). If the connector's federation path is incomplete, document what's missing and defer this test to a follow-up [owner:e2e-engineer] [type:testing] [beads:nx-bh2b6]
- [x] [4.6] Verify zero references to deleted symbols: `rg -n 'createRouter\|RouterOptions\|buildRoutes\|requiresAuth' apps/agent/src/ apps/nextjs/src/ tests/ packages/ 2>/dev/null` SHALL return zero matches outside spec markdown [owner:e2e-engineer] [type:testing] [beads:nx-bpex5]

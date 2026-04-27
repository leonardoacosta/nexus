# Implementation Tasks

<!-- beads:epic:nx-mhv7l -->
<!-- beads:feature:nx-jwmve -->

## DB Batch

- [x] [1.1] [P-1] No schema changes — placeholder retained for /apply batch ordering [owner:db-engineer] [type:db] [beads:nx-dbp3i]

## API Batch

- [x] [2.1] [P-1] Add build-time generator script `apps/agent/scripts/gen-version.ts` that writes `apps/agent/src/version.gen.ts` with `BUILD_SHA` (from `git rev-parse --short HEAD`) and `BUILT_AT` (ISO UTC); fail non-zero if Git unavailable [owner:api-engineer] [type:api] [beads:nx-7boqr]
- [x] [2.2] [P-1] Wire generator into `apps/agent/package.json` build script: `"build": "bun apps/agent/scripts/gen-version.ts && bun build src/index.ts --compile --outfile nexus-agent"` [owner:api-engineer] [type:config] [beads:nx-vly5x]
- [x] [2.3] [P-1] Add `apps/agent/src/version.gen.ts` to `.gitignore` (root or apps/agent local) [owner:api-engineer] [type:config] [beads:nx-3hdym]
- [x] [2.4] [P-2] Create `apps/agent/src/routes/version-builder.ts` exporting `buildVersionRoutes(allRoutes: Route[]): Route[]` that registers `GET /version` returning `{ buildSha: BUILD_SHA, builtAt: BUILT_AT, capabilities }`; capabilities computed once from `allRoutes.map(r => \`${r.method} ${r.path}\`).sort()` and deduplicated [owner:api-engineer] [type:api] [beads:nx-2szjp]
- [x] [2.5] [P-2] Modify `apps/agent/src/routes.ts` to construct the base routes first, then append `buildVersionRoutes(baseRoutes)` so the version handler sees its own `/version` entry in capabilities [owner:api-engineer] [type:api] [beads:nx-9hiul] [note: typed route table not dispatched; superseded by Path A wiring in server-request-handler.ts; follow-up nx-tw3vp]
- [x] [2.6] [P-2] Mark `GET /version` as auth-exempt in `apps/agent/src/server-auth.ts` (or whichever module enforces `x-nexus-secret`) [owner:api-engineer] [type:api] [beads:nx-4xvw5]
- [x] [2.7] [P-3] Add `apps/agent/src/routes/version-builder.test.ts` with bun tests covering payload shape, capability derivation, alphabetical sort, dedup, and auth bypass [owner:test-writer] [type:testing] [beads:nx-271sc]

## UI Batch

- [x] [3.1] [P-1] Create `apps/nextjs/src/lib/agent-reachability.ts` exporting `probeAgent(): Promise<Reachability>` where `Reachability` is the discriminated union from the spec; uses `getAgentBaseUrl()` + `fetchWithTimeout` + 5s timeout [owner:api-engineer] [type:api] [beads:nx-emat7]
- [x] [3.2] [P-1] Add `EXPECTED_CAPABILITIES` constant in `agent-reachability.ts` listing the routes the dashboard needs (`"GET /notifications/settings"`, `"PATCH /notifications/settings"`, `"GET /credentials"`); helper returns `stale-binary` when any are missing from agent's response [owner:api-engineer] [type:api] [beads:nx-n7j73]
- [x] [3.3] [P-2] Refactor `apps/nextjs/src/app/actions/notifications.ts` to attach the `Reachability` object to `NotificationsPageData` (replace `agentReachable: boolean` with `reachability: Reachability`); keep the boolean as a derived `reachability.ok` for components not yet updated [owner:api-engineer] [type:api] [beads:nx-ellkr]
- [x] [3.4] [P-2] Refactor `apps/nextjs/src/app/actions/credentials.ts` to use the same helper [owner:api-engineer] [type:api] [beads:nx-4vsef]
- [x] [3.5] [P-2] Update `apps/nextjs/src/app/notifications/NotificationsClient.tsx` to switch banner copy on `reachability.reason`: `stale-binary` shows "Agent build {sha} missing {missing[0]} — rebuild needed", `timeout`/`http-error` shows reachability-specific copy with host:port, `no-agent` shows registration CTA [owner:ui-engineer] [type:ui] [beads:nx-puylq]
- [x] [3.6] [P-2] Update `apps/nextjs/src/app/credentials/page.tsx` to use the same banner switching; preserve "No credentials found" empty-state when `reachability.ok === true` and credentials list is empty [owner:ui-engineer] [type:ui] [beads:nx-7rqpk]
- [x] [3.7] [P-3] Unit tests for `agent-reachability.ts` covering all five reachability branches with mocked fetch [owner:test-writer] [type:testing] [beads:nx-ae539]

## E2E Batch

- [x] [4.1] E2E test: with a running agent, hit dashboard `/notifications`, assert no "Agent unreachable" copy and that `data-testid="notifications-table"` renders [owner:e2e-engineer] [type:testing] [beads:nx-gv2wm]
- [x] [4.2] E2E test: stub `/version` to omit `"GET /notifications/settings"` from capabilities, assert banner copy contains the build SHA and the missing capability name, controls disabled [owner:e2e-engineer] [type:testing] [beads:nx-xf639]
- [x] [4.3] Manual verification gate: rebuild homelab agent (`cd apps/agent && bun run build && install -m 755 nexus-agent ~/.local/bin/ && systemctl --user restart nexus-agent`); curl `http://localhost:7400/version` and confirm 200 with full payload; load `/notifications` page and confirm controls are enabled [owner:e2e-engineer] [type:testing] [beads:nx-do040]

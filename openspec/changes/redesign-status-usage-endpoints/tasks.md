<!-- beads:epic:nx-ev2x5 -->
<!-- beads:feature:nx-4grlj -->

# Implementation Tasks

## DB Batch

- [ ] [1.1] [P-2] Drop `sessions.total_cost_usd` column via `drizzle-kit generate` migration; remove the dead write sites in `session-manager.ts`, `process-watcher.ts`, `routes/sessions.ts`, `stub-agent.ts` that always set it to `null` [owner:db-engineer] [type:db] [beads:nx-wj890]
- [x] [1.2] [P-1] Add `Account5H7D`/`SessionStatus`/composed statusline response types to `packages/core`; trim `Account.usagePercent`/`Account.resetsAt` per design.md contract [owner:types-engineer] [type:api] [beads:nx-8iq28]

## API Batch

- [ ] [2.1] [P-1] Rewrite `GET /statusline` to dispatch on `sessionId`/`accountId` query params per design.md's 4-mode contract; preserve today's neither-mode `sessions[]`/`git`/`machine`/`uptime_seconds` fields unchanged [owner:api-engineer] [type:api] [beads:nx-dobiy]
- [ ] [2.2] [P-1] Implement `accountId`-mode: read `credentials.usage5hUsed/Limit/ResetAt` + `usage7dUsed/Limit/ResetAt` by id, 404 if unknown [owner:api-engineer] [type:api] [beads:nx-vhk1x]
- [ ] [2.3] [P-1] Implement `sessionId`-mode project-status join (`sessions.projectId` -> `projects.name` -> `project_status_snapshots` latest row), reusing the existing `services/status-snapshots.ts` read path — no live shell-out [owner:api-engineer] [type:api] [beads:nx-7otbu]
- [ ] [2.4] [P-1] Implement `sessionId`-mode cost usage via `readSessionCostTokens(vm, sessionId)` and `sessionId`-mode `next` field via the existing `GET /recommend` logic composed in-process [owner:api-engineer] [type:api] [beads:nx-egh58]
- [ ] [2.5] [P-1] Trim `GET /credentials` response to drop `usagePercent`/`resetsAt`; retire `GET /projects/:id/status`, `GET /sessions/{id}/tokens`, `GET /recommend` as standalone routes now that `/statusline` composes their data [owner:api-engineer] [type:api] [beads:nx-3czpz]
- [ ] [2.6] [user] DECISION: which shape is real for `GET /credentials/{id}/usage?window=` (see design.md "Known open drift") — searched: account.ts, credential-analytics/credential-page-status specs, handlers-health-usage.ts (permission-blocked); no documented pattern resolves it. [type:config] [beads:nx-ysmwm]
- [ ] [2.7] [P-2] Add a `/sessions`-family-consistent alias for the existing `POST /session/start` (keep the current singular path working) [owner:api-engineer] [type:api] [beads:nx-dck7c]

## UI Batch

- [ ] [3.1] [P-2] Migrate Swift dashboard Credentials view off `Account.usagePercent`/`resetsAt` onto `GET /statusline?accountId=` [owner:swift-engineer] [type:ui] [beads:nx-rqpio]
- [ ] [3.2] [P-2] Migrate `apps/web`'s credentials consumer (`integration-client.ts`) off the retired `Account` usage fields [owner:ui-engineer] [type:ui] [beads:nx-fgrs2]
- [ ] [3.3] [P-2] Update `apps/nexus-statusline` (`render.ts`/`agent-lines.ts`) to consume the composed `sessionId`-mode fields where applicable [owner:api-engineer] [type:ui] [beads:nx-m7hc0]

## E2E Batch

- [ ] [4.1] [P-1] Vitest coverage for `GET /statusline`'s 4-mode dispatch (neither / accountId / sessionId / both=400), the session-to-project join, cost-usage composition, and the `GET /credentials` usage-field removal [owner:tdd-integration] [type:testing] [beads:nx-ws952]
- [ ] [4.2] [P-2] Regression test confirming `sessions.total_cost_usd` column removal does not break existing session-serialization tests [owner:test-writer] [type:testing] [beads:nx-1gw6k]

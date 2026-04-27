# Implementation Tasks

<!-- beads:epic:nx-at7fv -->
<!-- beads:feature:nx-bbvnm -->

## DB Batch

- [x] [1.1] [P-1] Verify `agents` table read order is stable (insertion order via `id` ASC) by inspecting `getAgentConfigs()` query in `apps/nextjs/src/lib/get-client.ts`. If non-deterministic, add an explicit `orderBy(asc(agents.createdAt))` to guarantee DB-order failover semantics. No schema change [owner:db-engineer] [type:db] [beads:nx-5x52g]

## API Batch

- [x] [2.1] [P-1] Create `apps/nextjs/src/lib/agent-cache.ts` exporting a module-scoped `Map<string, { result: Reachability; expiresAt: number }>` with `get(key)`, `set(key, result, ttlMs)`, `invalidate(key)`, and `clear()`. Default TTL 60_000ms. The single key is the literal string `"active"` (process-scoped, not per-tenant) [owner:api-engineer] [type:api] [beads:nx-vhdmf]
- [x] [2.2] [P-1] Replace `getAgentBaseUrl()` in `apps/nextjs/src/lib/agent-url.ts` with `probeAgents()`: returns `{ active: AgentBaseUrlResolution, peers: AgentConfig[] }` where `peers` is the remaining ordered tail after the responder. Probes registry in DB order, returns on first successful `/version` 2xx + capability match. Preserve a thin compat shim `getAgentBaseUrl()` that calls `probeAgents()` and returns `active` (back-compat for unrelated callers) [owner:api-engineer] [type:api] [beads:nx-kr2i5]
- [x] [2.3] [P-1] Rewrite `probeAgent()` in `apps/nextjs/src/lib/agent-reachability.ts` as `probeAgents()`: iterates the registry, returns `{ ok: true, ..., agent, failover, attempts }` on first responder, only returns failure when all agents exhausted. Add `failover: boolean` (true when responder is not the first in DB order). Add `attempts: { agent, reason }[]` for diagnostics. Consult `agent-cache` first; cache only ok-results; on cache hit attach `cached: true` [owner:api-engineer] [type:api] [beads:nx-7lxem]
- [x] [2.4] [P-1] Create `apps/nextjs/src/lib/agent-failover.ts` exporting `withFailover<T>(fn: (agent: AgentConfig) => Promise<T>): Promise<T>`. Calls `fn` against cached agent → on network/5xx failure walks the next peer → on success refreshes cache. Detects retriable failures: thrown errors from `fetchWithTimeout`, plus `Response.status >= 500`. 4xx and 2xx surface directly. Logs `[agent-failover] <from> -> <to>` on transition. Throws aggregated error with all attempted agent names when registry exhausted [owner:api-engineer] [type:api] [beads:nx-ci7wj]
- [ ] [2.5] [P-2] Wrap fetches in `apps/nextjs/src/app/actions/notifications.ts` with `withFailover` so the `/notifications/settings` GET and PATCH transparently fail over [owner:api-engineer] [type:api] [beads:nx-06bqd]
- [ ] [2.6] [P-2] Wrap fetches in `apps/nextjs/src/app/actions/elevenlabs-credentials.ts` and `apps/nextjs/src/app/api/notifications/stream/route.ts` with `withFailover` for the credential read path. SSE proxy path uses `probeAgents()` to pick the active agent at connection time; failover within an open SSE stream is OUT of scope [owner:api-engineer] [type:api] [beads:nx-853jn]
- [ ] [2.7] [P-2] Unit tests in `apps/nextjs/src/lib/__tests__/agent-reachability.test.ts`: 1st-up returns ok no-probe-2nd, 1st-down 2nd-up returns ok+failover, all-down returns last-attempt failure with attempts[], stale-binary on 1st falls through to 2nd [owner:test-writer] [type:testing] [beads:nx-s35k8]
- [ ] [2.8] [P-2] Unit tests in `apps/nextjs/src/lib/__tests__/agent-failover.test.ts`: cache-hit skips network, cache-miss reprobes after TTL, withFailover retries on network error and updates cache, withFailover does NOT retry on 4xx, all-fail throws aggregated error and clears cache [owner:test-writer] [type:testing] [beads:nx-iuse8]

## UI Batch

- [ ] [3.1] [P-1] Update `apps/nextjs/src/app/notifications/NotificationsClient.tsx` to hide the unreachable banner when `reachability.ok === true`, regardless of which agent responded. When `reachability.failover === true`, render a small text indicator "using <agent.name>" near the page header (informational style, not error) [owner:ui-engineer] [type:ui] [beads:nx-g5gdv]
- [ ] [3.2] [P-1] Update `apps/nextjs/src/app/credentials/page.tsx` to apply the same banner-hide-on-ok + "using <name>" indicator pattern. Preserve the existing "No credentials found" empty-state copy when reachability.ok and credentials list is empty [owner:ui-engineer] [type:ui] [beads:nx-col96]
- [ ] [3.3] [P-2] Add `data-testid="agent-failover-indicator"` to the indicator element on both pages so e2e/inspection scripts can locate it without scraping copy [owner:ui-engineer] [type:ui] [beads:nx-0vl68]

## E2E Batch

- [ ] [4.1] [user] Stop the macbook agent (`launchctl unload ~/Library/LaunchAgents/com.nexus.agent.plist`), confirm the dashboard at `:3100/notifications` continues to show enabled controls (homelab agent answers); verify the "using homelab" indicator appears in the header region; restart the macbook agent and confirm indicator disappears within 60s (TTL window) [owner:user] [type:testing] [beads:nx-kla25]
- [ ] [4.2] [user] With both agents running, confirm `/credentials` shows credentials read from the first agent in DB order without any indicator (no failover happened); inspect server logs to confirm zero `[agent-failover]` log lines were emitted [owner:user] [type:testing] [beads:nx-wf47e]
- [ ] [4.3] [user] Stop ALL agents (both macbook and homelab daemons offline). Confirm both `/notifications` and `/credentials` show the unreachable banner naming the last attempted agent. Confirm controls are disabled. Restart one agent and confirm the page recovers within 60s without a hard refresh [owner:user] [type:testing] [beads:nx-wkmrz]

---
status: draft
---

# Proposal: Dashboard Agent Failover

## Change ID
`dashboard-agent-failover`

## Summary
Treat the agent registry as an ordered failover pool: probe agents in DB order, return the first responder, and transparently retry the next agent when a single fetch fails mid-request. Hide the unreachable banner when ANY agent responds.

## Context
- Extends: `apps/nextjs/src/lib/agent-url.ts`, `apps/nextjs/src/lib/agent-reachability.ts`, `apps/nextjs/src/lib/agent-client.ts`, `apps/nextjs/src/app/notifications/NotificationsClient.tsx`, `apps/nextjs/src/app/credentials/page.tsx`
- Related: archived `agent-version-handshake` (introduced the `Reachability` discriminated union), `apply-4-findings` (consolidated dispatcher)

## Motivation
`getAgentBaseUrl()` returns the FIRST enabled agent and stops. When that agent is offline (e.g. macbook daemon not running) the dashboard renders "Agent macbook returned timeout" even though a perfectly healthy homelab agent sits next in the registry. The user sees a banner, can't reach controls, and has to manually disable the broken agent in DB to restore the page.

This is the wrong default for a multi-machine peer-to-peer topology. The registry IS the failover order. We should walk it.

## Requirements
- Replace single-agent resolution with ordered probe-and-pick: walk `getAgentConfigs()` in DB order, return on first 2xx `/version`.
- Cache the last responder in-memory with a 60s TTL keyed by process scope. Subsequent requests skip the probe and go straight to the cached agent.
- On a mid-request failure (cached agent returns network error or 5xx), transparently retry the same operation against the next agent in the registry; refresh cache to point at the new responder.
- Reachability is `ok: true` the moment ANY agent responds. The banner hides. A small "using <agent-name>" indicator surfaces in the page header when the active agent is NOT the first in DB order (i.e. failover happened).
- Capability check still applies — failover only succeeds against an agent that serves the required capabilities.

## Scope
- **IN**:
  - `agent-url.ts` — replace `getAgentBaseUrl()` with `probeAgents()` (returns first responder + ordered list of remaining peers for retry)
  - `agent-reachability.ts` — iterate the registry; ok:true on first responder; only return failure when ALL agents fail
  - In-memory TTL cache keyed by module scope (60s default)
  - Retry helper wrapping `fetchWithTimeout` that consumes the ordered peer list on transparent failover
  - `NotificationsClient.tsx`, `credentials/page.tsx` — hide banner when reachability.ok; surface "using <name>" indicator when failover occurred
- **OUT**:
  - DB schema changes (agents table already has implicit insertion order)
  - Cross-process cache (Redis, etc.) — single-process in-memory is enough for this dashboard
  - Health-aware preference (e.g. always pick the lowest-latency agent) — strict DB order keeps the model dead simple
  - WebSocket failover (terminal attach, SSE streams) — out of scope; this proposal is about server-action / fetch failover only
  - Persistent failure tracking ("agent X has failed 3 times, deprioritize it") — TTL cache implicitly handles this for 60s windows

## Impact

| Area | Change |
|------|--------|
| `apps/nextjs/src/lib/agent-url.ts` | Replace `getAgentBaseUrl()` with `probeAgents()` returning first responder + remaining peers |
| `apps/nextjs/src/lib/agent-reachability.ts` | `probeAgent()` becomes `probeAgents()` — iterates registry, returns ok on first responder |
| `apps/nextjs/src/lib/agent-cache.ts` (new) | In-memory TTL cache module, 60s default |
| `apps/nextjs/src/lib/agent-failover.ts` (new) | `withFailover<T>(fn)` wrapper that retries against next peer on network error |
| `apps/nextjs/src/app/actions/notifications.ts` | Wrap fetch calls in `withFailover` |
| `apps/nextjs/src/app/actions/elevenlabs-credentials.ts` | Wrap fetch calls in `withFailover` |
| `apps/nextjs/src/app/notifications/NotificationsClient.tsx` | Show "using <name>" indicator on failover; hide banner when ok |
| `apps/nextjs/src/app/credentials/page.tsx` | Same indicator pattern |
| `apps/nextjs/src/lib/__tests__/agent-reachability.test.ts` | New cases: 1st down + 2nd up returns ok; all down returns failure of last attempt |
| `apps/nextjs/src/lib/__tests__/agent-failover.test.ts` (new) | Retry-on-next-peer behavior + cache invalidation |

## Risks

| Risk | Mitigation |
|------|-----------|
| 60s TTL caches a stale-binary agent | Cache stores the FULL `Reachability` result; capability check reruns on cache miss; manual invalidation if a deploy goes through |
| Probe-all on every request is slow when N agents grow large | Cache hit covers steady-state; cold cache costs `min(N, 2) * 5s timeout` — same as today's worst case for N=2 |
| Transparent failover masks real outages | Each failover logs `[agent-failover] <name> -> <next>` to server logs; ops can grep |
| Mid-request failover is non-idempotent for writes (PATCH /notifications/settings) | Failover only retries on connection error / 5xx; PATCH that returns 4xx is NOT retried (semantic failure, not network) |
| Two requests land on different agents mid-session | Acceptable for read paths; PATCH/POST writes go to whichever agent the cache currently points at — registry is single-writer per agent so there's no DB conflict |

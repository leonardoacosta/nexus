# Tasks — add-radar-source-panel
<!-- beads:epic:nx-rkq6t -->
<!-- beads:feature:nx-b3k17 -->

## API Batch
- [x] [1.1] `apps/agent/src/routes/requests.ts` — `GET /requests` passthrough to `${MX_GATEWAY_URL}/requests` forwarding status/source/changed_since params; mirror the fail-soft + logging shape of the existing `/sources` passthrough (`server-request-handler.ts:676-690`); register the route + method-guard entry. [beads:nx-tdo3s]

## UI Batch
- [x] [2.1] `apps/web/src/app/radar/page.tsx` — fetch `/sources` via `NEXT_PUBLIC_NEXUS_AGENT_URL`; render one row per source (name, status, last scan, item count, MINE count, last error); unhealthy rows visually distinct; unset-URL renders the configure message per web-dashboard convention. [beads:nx-920w0]
- [x] [2.2] `apps/web/src/app/radar/source-row.tsx` + `drawers.tsx` — expandable row with scan-log drawer (health/scan fields for that source) and request-history drawer (`/requests?source=&changed_since=` transitions: title, old -> new, timestamp); gateway-down or feed-missing renders a named empty state, never a crash or infinite spinner. [beads:nx-gxgoy]
- [x] [2.3] Per-source hide/show toggles persisted in localStorage; hidden sources excluded from rows but counted in a summary chip. [beads:nx-liqkv]

## E2E Batch
- [ ] [3.1] Agent test: `/requests` passthrough forwards params + auth and returns 502-class JSON when the gateway is down (mirror existing /sources passthrough tests). [beads:nx-p42j0]
- [ ] [3.2] Web tests: healthy+degraded rows render from a stubbed SourceIndex; history drawer renders transitions from stubbed /requests; missing feed shows the named empty state; hide toggle survives reload (localStorage). [beads:nx-x8izy]

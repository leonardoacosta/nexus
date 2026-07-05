# Add Radar Source Panel (per-source status rows + log/history drawers in apps/web)

## Why

Leo wants one surface showing the request-radar's health and history: each source (teams,
outlook, ado, snow, gmail) as a row with live status, plus two drawers per row — the service's
scan/log history and the request/DB history. Today nexus-agent already proxies the mx gateway
(`GET /sources`, `GET /triage` passthroughs in `apps/agent/src/server-request-handler.ts:676-690`)
and `apps/web` exists, but nothing renders source health or history, and the cc-side
`request-radar` skill this replaces is auth-degraded and session-bound.

Cross-repo context: mx proposal `add-aggregator-request-store` (mx repo, openspec) adds the
durable `GET /requests` + `mx_request_events` feed the history drawer reads. The status rows
and scan-log drawer work against surfaces that exist today.

## What Changes

- nexus-agent: `GET /requests` passthrough to the mx gateway (same pattern as the existing
  `/sources` + `/triage` passthroughs, auth via existing middleware).
- apps/web: a `/radar` page — one row per source from `/sources` (status, last scan, item
  count, ball==MINE count, error), expandable with two drawers:
  - **Scan log drawer**: recent scan outcomes/errors for that source (from the SourceIndex
    health fields; enriched by cron_runs-style history if/when mx exposes per-scan records).
  - **Request history drawer**: recent `mx_request_events` transitions for that source via the
    new `/requests?changed_since=` feed (disposition flips, resolves, re-surfaces).
- Config affordances v1: per-source show/hide toggle persisted client-side. Frequency and
  triage-prompt configuration are deliberately OUT of v1 — mesh scan cadence is env-owned
  (`MX_*_SCAN_INTERVAL`) and no LLM prompt exists in the mesh path yet (gmail categorize +
  future initiative labeling own prompts; wire config when mx exposes them).

## Context

- touches: `apps/agent/src/server-request-handler.ts`, `apps/agent/src/routes/requests.ts`, `apps/web/src/app/radar/page.tsx`, `apps/web/src/app/radar/source-row.tsx`, `apps/web/src/app/radar/drawers.tsx`

## Impact

- Affected specs: NEW capability `radar-panel`.
- No DB in nx: all data proxied from the mx gateway; web stays a thin render.
- Request-history drawer degrades gracefully (empty state + note) until mx
  `add-aggregator-request-store` ships `GET /requests`.

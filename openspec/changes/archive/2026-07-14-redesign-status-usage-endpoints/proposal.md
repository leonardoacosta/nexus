---
status: draft
---

# Proposal: Redesign Status/Usage API Surface

## Change ID
`redesign-status-usage-endpoints`

## Summary
Split nx's status/usage surface by true resource lifecycle instead of by consumer: `GET
/credentials` becomes a pure account-registry endpoint, `GET /statusline` becomes the single
authoritative read-model for everything cc-statusline/cc-tmux/dashboards need (account 5H/7D
usage, per-session model letter, per-session cost usage, per-session-project git/beads/openspec
status, next-action recommendation), and the `/sessions` route family narrows to session
lifecycle only (never embedding account/credential details, since a session's credential can
rotate mid-session via a swap event).

## Context
- Extends: `apps/agent/src/routes/statusline.ts`, `apps/agent/src/routes/credentials.ts`,
  `apps/agent/src/routes/sessions.ts`, `apps/agent/src/routes/session-context.ts`,
  `apps/agent/src/routes/project-status.ts`, `apps/agent/src/routes/recommend.ts`,
  `packages/core/src/types/account.ts`, `packages/core/src/types/session.ts`,
  `packages/core/src/types/project-status.ts`
- Related: `add-session-model-authority` (nx-iwk95, archived 2026-07-13 — model letter is now
  live, this proposal composes it into the wider response), `add-session-context-api`,
  `add-project-status-snapshots`, `read-cc-telemetry-from-influxdb` (cc-telemetry-read — the
  real, current source for per-session cost, superseding the dead `sessions.total_cost_usd`
  column and its stale `credential-analytics` spec description)
- touches: `apps/agent/src/routes/statusline.ts`, `apps/agent/src/routes/credentials.ts`,
  `apps/agent/src/routes/sessions.ts`, `apps/agent/src/routes/session-context.ts`,
  `apps/agent/src/routes/project-status.ts`, `apps/agent/src/routes/recommend.ts`,
  `apps/agent/src/routes/roadmap.ts`, `apps/agent/src/services/status-snapshots.ts`,
  `apps/agent/src/telemetry/session-cost-read.ts`, `packages/core/src/types/account.ts`,
  `packages/core/src/types/session.ts`, `packages/core/src/types/project-status.ts`,
  `packages/db/src/schema/sessions.ts`, `apps/nexus-statusline/src/render.ts`,
  `apps/nexus-statusline/src/agent-lines.ts`, `apps/swift/nexus-mac/Sources/*Credentials*`,
  `apps/web/src/lib/integration-client.ts`

## Motivation
Today the same underlying data is split across endpoints by *who asked for it first*, not by
what it is:

- Account-level Anthropic 5H/7D usage windows live under `GET /credentials` /
  `GET /credentials/{id}/usage` (credential-keyed).
- Session model letter lives under `GET /statusline` / `GET /sessions/:id/context`
  (session-keyed).
- Per-session cost usage lives under `GET /sessions/{id}/tokens`, reading VictoriaMetrics via
  `readSessionCostTokens` (cc-telemetry-read) — NOT the dead `sessions.total_cost_usd` DB column,
  which every write site sets to `null`.
- Per-project beads/openspec/git status lives under `GET /projects/:id/status`, backed by the
  already-cached `project_status_snapshots` table.
- Next-action recommendation lives under `GET /recommend`.

A caller building a statusline or dashboard has to fan out to 5 endpoints and stitch the results
by hand. This proposal collapses the read side into one endpoint shaped around the two axes
that actually matter to a caller — "give me everything for account X" or "give me everything for
session Y" — while leaving `/credentials` and `/sessions` scoped to what they're actually
authoritative for: identity and lifecycle, respectively.

## Requirements

### Requirement: `GET /statusline` accepts nullable `sessionId`/`accountId` filters
See `session-persistence` spec delta for the full four-mode contract (neither / accountId only /
sessionId only / both — 400).

### Requirement: `GET /credentials` drops usage fields
`Account.usagePercent` / `Account.resetsAt` are removed from the wire type; usage moves
exclusively to `/statusline?accountId=`. See `session-persistence` spec delta (new
`accountId`-mode requirement) for the replacement shape.

### Requirement: Per-session status is resolved via the session's project, not the agent's cwd
`GET /statusline?sessionId=` resolves `sessions.projectId → projects.name →
project_status_snapshots.project` to source beads/openspec/git status, replacing today's
single global git object computed from the agent process's own cwd. See `session-persistence`
spec delta.

### Requirement: `/sessions` route family absorbs `POST /session/start`
The existing (already-implemented) `POST /session/start` becomes reachable under the `/sessions`
family naming; `/sessions` continues to never embed account/credential identity in its own
response shape. See `session-launch` spec delta.

## Scope
- **IN**: `GET /statusline` four-mode contract (account 5H/7D, model_letter, session cost usage,
  per-session-project git/beads/openspec, next-action); `GET /credentials` usage-field removal;
  retiring `GET /projects/:id/status`, `GET /sessions/{id}/tokens`, and `GET /recommend` as
  standalone routes (absorbed); `POST /session/start` reachable under `/sessions`; migrating the
  known consumers (`apps/nexus-statusline`, Swift dashboard Credentials view, `apps/web`) off the
  retired routes/fields; removing the dead `sessions.total_cost_usd` write sites (DB column and
  its always-null writers) as cleanup now that the real source is confirmed to be VictoriaMetrics.
- **OUT**: `GET /credentials/{id}/usage?window=1h|6h|24h|7d` (credential-analytics' internal
  cost-rollup endpoint, a distinct concept from the Anthropic 5H/7D rate-limit window — not
  touched); `GET /credentials/{id}/usage-history` (trend-chart time series — different concern
  from "current status", stays as-is); cc-tmux migration (separate repo,
  `~/dev/personal/installfest`, noted as a downstream follow-up only); any new tmux
  session-lifecycle capability beyond the existing spawn/rename; reconciling the stale
  `credential-http-endpoint` spec (describes a pre-migration Rust-era port-7401/X-Nexus-Secret
  API that no longer matches the shipped Bun implementation — flagged in Risks, needs its own
  spec-hygiene pass, not fixed here to avoid scope creep).

## Testing
| Affected seam | Unit task | E2E task |
|----------------|-----------|----------|
| `GET /statusline` 4-mode dispatch + validation | `[2.1]` `[2.2]` | `[4.1]` |
| Session→project resolution for per-session status | `[2.3]` | `[4.1]` |
| Session-cost composition via `readSessionCostTokens` | `[2.4]` | `[4.1]` |
| `GET /credentials` usage-field removal | `[2.5]` | N/A — response-shape change, covered by `[4.1]`'s statusline assertions |
| `packages/core` wire-type changes (`Account`, statusline response) | `[1.1]` | N/A — type-only |
| Swift Credentials view migration off `Account.usagePercent` | `[3.1]` | N/A — no existing Swift E2E harness for this view; manual verify per `swift` skill's headless-build contract |
| `apps/web` consumer migration | `[3.2]` | N/A — no e2e coverage of this surface today |
| `nexus-statusline` consumption of composed fields | `[3.3]` | N/A — statusline app has no automated test harness; verify via rendered output per `run` skill |

## Impact
| Area | Change |
|------|--------|
| `apps/agent/src/routes/statusline.ts` | Major rewrite — 4-mode query dispatch, composes credentials/session/project-status/telemetry reads |
| `apps/agent/src/routes/credentials.ts` | Trim `Account` response — drop usage fields |
| `apps/agent/src/routes/project-status.ts`, `recommend.ts` | Routes retired (logic moves into statusline composition) |
| `apps/agent/src/routes/sessions.ts` | `GET /sessions/{id}/tokens` retired; `POST /session/start` reachable under `/sessions` |
| `packages/core/src/types/account.ts`, `session.ts`, `project-status.ts` | Wire-type trims + new composed statusline response type |
| `packages/db/src/schema/sessions.ts` | `total_cost_usd` column + dead write sites removed |
| `apps/nexus-statusline`, Swift dashboard, `apps/web` | Migrate off retired routes/fields |

## Risks
| Risk | Mitigation |
|------|-----------|
| Folding beads/openspec/git/next into a per-render statusline call reintroduces the `bd ready` ~1.8s latency class already fixed once (session-primer-single-ready ratchet row, cc repo) | Compose via the already-cached `project_status_snapshots` read path (`GET /projects/:id/status`'s existing backing service), never a live shell-out from the route handler |
| `credential-analytics` and `credential-page-status` describe conflicting response shapes for the same URL `GET /credentials/{id}/usage` (token-rollup vs percent/resetsAt) — could not resolve from code (handler file is permission-blocked to Read directly) | Delta only touches the verified-in-code `Account.usagePercent`/`resetsAt` shape; the conflicting endpoint is left alone and the drift is flagged for a separate spec-hygiene pass |
| `credential-http-endpoint` spec describes a pre-migration Rust API (port 7401, `X-Nexus-Secret`, `active_account`/`best_available` fields) not present in the current Bun routes | Not touched by this proposal; flagged as a pre-existing spec-drift issue needing its own reconciliation pass |
| Consumers (nexus-statusline, Swift dashboard, apps/web, and cc-tmux in a separate repo) must migrate off retired routes before/alongside this shipping | UI Batch tasks migrate the three in-repo consumers in the same wave; cc-tmux is explicitly out of scope (separate repo, noted as follow-up) |

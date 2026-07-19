---
order: 0719c
---

# Proposal: Mechanize route-registry parity

## Change ID
`mechanize-route-registry-parity`

## Summary
`LEGACY_DISPATCH_ROUTES` (the source-of-truth list for `GET /version`'s `capabilities` array) has
already drifted from the live if/else dispatch chain in `server-request-handler.ts`. Fix the
drift now, replace the 57 copy-pasted CORS/error-wrapper blocks with one shared helper, and add a
test that fails the build the next time the two lists diverge — instead of relying on manual
audits to catch it.

## Context
- Extends: `apps/agent/src/server-request-handler.ts` (LEGACY_DISPATCH_ROUTES array + the
  if/else dispatch chain in `handleRequestInner`)
- Related: `apps/agent/src/routes/version-builder.ts` (`buildVersionRoutes` consumes the array
  read-only to compute `/version`'s `capabilities` field — not modified by this proposal, the
  fix stays entirely inside `server-request-handler.ts`)
- touches: `apps/agent/src/server-request-handler.ts`, `apps/agent/src/server-request-handler-route-parity.test.ts`

## Motivation
Adversarially confirmed against base commit `c25cd89d` via the `improve:code` lens (findings
GOD-01, GOD-02):

- **GOD-01**: `LEGACY_DISPATCH_ROUTES` (lines 120-243) carries an explicit comment — "MUST be
  kept in sync with the if/else dispatch chain" — and has already drifted: `POST
  /apns/register` (dispatched at line 515) and `POST /capture` (dispatched at line 905) are both
  live routes missing from the array, so `GET /version`'s `capabilities` field misrepresents the
  real API surface. The header comment (lines 110-113) also cites a typed `routes.ts` route
  table that no longer exists — it was deleted by `apply-4-findings`, per
  `apps/agent/src/routes/version-builder.ts`'s own header comment.
- **GOD-02**: the same file repeats one 5-line wrapper —
  `.then((r) => withCors(request, r)).catch((err) => { logger.error(...); return
  withCors(request, new Response(...)) })` — verbatim 57 times, one per route (~300 lines of
  boilerplate). Three deliberate per-route fail modes are buried inside the copy-paste: `500`
  (the default, ~54 routes), fail-soft `200` with a route-specific empty body (`/beads/unlinked`,
  `/version`'s capability probe, `/sources`, `/requests`, `/queue`, `/decisions`, `/triage`,
  `/thread`), and fail-loud `502` (`/requests/:id/decision`, `/capture`, `/paste` — each carries
  an explicit "NOT fail-soft" comment because a swallowed failure there is worse than a loud one).

## Requirements

### Requirement: LEGACY_DISPATCH_ROUTES matches the live dispatch chain
`LEGACY_DISPATCH_ROUTES` SHALL list every route actually reachable through the `handleRequestInner`
if/else chain, with no extra and no missing entries, at all times.

### Requirement: Route-registry drift is caught mechanically
An automated test SHALL fail whenever `LEGACY_DISPATCH_ROUTES` and the live dispatch chain
diverge, so a future added/removed route without a matching array update breaks locally and in
CI instead of silently shipping a wrong `/version` capability list.

### Requirement: Per-route fail-mode boilerplate is deduplicated without behavior change
The repeated `.then(...).catch(...)` CORS/error-wrapper block SHALL be extracted into one shared
helper. Every route's current fail mode (default 500, fail-soft 200 with its existing body, or
fail-loud 502) SHALL be preserved exactly — the refactor changes only where the wrapper code
lives, never what any route returns on success or failure.

## Scope
- **IN**: fixing the two missing `LEGACY_DISPATCH_ROUTES` entries; fixing the stale `routes.ts`
  header comment; extracting a shared dispatch/response-wrapper helper for the 57 duplicated
  blocks while preserving every route's exact current fail mode; adding a test that fails on
  future drift between `LEGACY_DISPATCH_ROUTES` and the live dispatch chain.
- **OUT**: migrating the dispatcher to the typed route table (`routes.ts` / a `buildRoutes()`
  style registry) — that is the larger, separately-tracked migration the existing header comment
  references (follow-up bead `nx-*`), not this proposal. `version-builder.ts` is not modified.

## Done Means
- `GET /version`'s `capabilities` array includes `"POST /apns/register"` and `"POST /capture"`.
- A route present in the dispatch chain but absent from `LEGACY_DISPATCH_ROUTES` (or vice versa)
  fails a bun test run, not just a manual read of the source.
- The header comment above `LEGACY_DISPATCH_ROUTES` no longer references the deleted `routes.ts`
  typed table.
- Every one of the 57 previously-duplicated routes still returns its pre-refactor status code and
  body shape on both success and simulated handler failure.

## Testing
| Affected seam | Unit task | E2E task |
|----------------|-----------|----------|
| `LEGACY_DISPATCH_ROUTES` vs. live dispatch chain parity | [1.3] new parity test in `server-request-handler-route-parity.test.ts` | N/A — route-table hygiene, no user-facing flow |
| Shared dispatch/response-wrapper helper (fail-mode preservation) | [1.2] extraction verified by existing per-route tests (`apns-register.test.ts`, `capture.test.ts`, `paste.test.ts`, `beads-unlinked.test.ts`, `roadmap.test.ts`, `server-request-handler.test.ts`, etc.) staying green | N/A — internal refactor, no route contract change |
| Full agent package regression | [1.4] `bun test` run for `apps/agent`, confirmed green | N/A |

## Impact
| Area | Change |
|------|--------|
| `apps/agent/src/server-request-handler.ts` | Two rows added to LEGACY_DISPATCH_ROUTES; stale header comment fixed; 57 duplicated wrapper blocks replaced by calls to one shared helper |
| apps/agent test suite | One new test file enforcing route-registry parity going forward |
| GET /version response | capabilities array gains "POST /apns/register" and "POST /capture" |

## Risks
| Risk | Mitigation |
|------|-----------|
| Extracting the shared wrapper helper accidentally changes a route's status code or body on the failure path | Enumerate every route's current fail mode (500 default / fail-soft-200 with its exact body / fail-loud-502) before converting, pass fail mode as an explicit argument per call site, and lean on the existing per-route tests plus the full `bun test` run (task 1.4) to catch any regression |
| The parity test itself drifts from the real dispatch-matching logic (e.g. misses a regex-parameterised route) and gives false confidence | Cover both exact-path routes and the smaller set of regex-parameterised routes (`/sessions/:id`, `/projects/:id`, `/notifications/voices/:project`, etc.) explicitly in the test, asserting against the full `LEGACY_DISPATCH_ROUTES` set rather than a subset |

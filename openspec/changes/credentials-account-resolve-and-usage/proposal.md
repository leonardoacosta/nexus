---
status: approved
approved-by: leo@leonardoacosta.dev
approved-at: 2026-05-21T14:43:29-05:00
---
# Proposal: credentials-account-resolve-and-usage

## Why

Three gaps in the Credentials tab today:

1. **Account name often blank.** `probeIdentity()` populates
   `accountEmail` / `accountName` / `orgName` on credential add — but
   credentials added before that feature shipped never get re-probed,
   and a credential whose first probe failed (network blip) stays
   anonymous forever. The dashboard then shows "(no name)" instead of
   `leo@priceless.dev`.

2. **No usage / reset-time visibility.** The /credentials/:id/usage
   endpoint exists but returns LOCAL session_token_turns aggregates
   ("how many tokens did this credential consume IN OUR DB?"). The
   Anthropic-side data — utilization vs the 5h/7d caps + when those
   windows reset — is what actually tells you "this credential is
   about to rate-limit". That data is available at
   `https://api.anthropic.com/api/oauth/usage` (the same URL we
   already probe for the health check) but the response is currently
   discarded after the 401-vs-not check.

3. **Visible duplicates.** The pool already groups by
   `duplicate_group_id` (rows sharing an OAuth refresh token), but
   GET /credentials returns ALL rows. The dashboard shows 3 entries
   for "leo@priceless.dev" when there's really one account spread
   across 3 stored blobs.

The fix is one consolidated rewrite: a usage poller + identity
re-probe + dedupe-aware list response + the UI surface.

## What Changes

1. **`credentials` schema gains 7 columns** for the latest usage
   snapshot per credential: `usage_5h_used` (int), `usage_5h_limit`
   (int), `usage_5h_reset_at` (timestamptz), `usage_7d_used`,
   `usage_7d_limit`, `usage_7d_reset_at`, `usage_polled_at`. All
   nullable for back-compat. Drizzle migration appended.

2. **`credential-usage-poller.ts` service** — wakes every 5 minutes,
   iterates `credentials` rows where `is_primary AND status='available'`,
   calls `/api/oauth/usage` per access token, parses the response
   (`{ five_hour: { used, limit, resets_at }, seven_day: {...} }`),
   writes the snapshot to the row. Per-poll concurrency 4 (avoid
   hammering Anthropic). Errors logged + counted; never throw.

3. **POST /credentials/:id/refresh-identity** — manually trigger
   `probeIdentity()` on a single credential. Returns the new
   `{ accountName, accountEmail, orgName, accountUuid, orgUuid }` or
   `{ error }`. Used by the dashboard's "refresh" button on rows with
   blank names. Idempotent — safe to call repeatedly.

4. **POST /credentials/refresh-identity-all** — re-probe every
   credential whose `accountEmail IS NULL`. Returns summary
   `{ probed, succeeded, failed }`. One-shot maintenance endpoint;
   the poller also re-probes opportunistically on usage call when
   identity fields are blank.

5. **GET /credentials?dedupe=true** — collapse by
   `duplicate_group_id`, returning only `is_primary` rows. Each row
   gains `siblingCount: number` (how many duplicates were hidden) and
   `siblingIds: string[]` (their ids, for delete-all-duplicates UX).
   Default behavior (no query param) stays unchanged — all rows
   returned, no `siblingCount` field — to preserve back-compat with
   the existing dashboard and any CLI consumers.

6. **Credential row enrichment** — every GET /credentials row gains
   the new usage fields (`usage5hUsed`, `usage5hLimit`,
   `usage5hResetAt`, plus 7d equivalents, plus `usagePolledAt`) on
   top of the existing enrichment. Null when the poller hasn't
   sampled yet.

7. **CredentialsView UX** — three changes:
   - **Usage bars**: per-row, two horizontal bars (5h / 7d) showing
     `used / limit * 100%` colored green→yellow→red at 70%/90%.
   - **Reset countdown**: `Resets in 2h 14m` next to each bar,
     ticking down via `TimelineView`.
   - **Refresh identity button**: shown on rows where
     `accountEmail == nil`. Calls POST /credentials/:id/refresh-identity
     and optimistically updates the row.
   - **Dedupe toggle**: a switch at the top of the list (default ON)
     that drives the `?dedupe=true` query param. When OFF, all rows
     show; when ON, primary-only rows with a `+2 duplicates`
     summary chip.

## Context

- depends on: 
- touches: `packages/db/src/schema/credentials.ts`, `packages/db/drizzle/0035_add_credential_usage_columns.sql`, `apps/agent/src/credentials/pool/pool-core.ts`, `apps/agent/src/services/credential-usage-poller.ts`, `apps/agent/src/services/credential-usage-poller.test.ts`, `apps/agent/src/routes/credentials/handlers-crud.ts`, `apps/agent/src/routes/credentials/handlers-refresh-identity.ts`, `apps/agent/src/routes/credentials/index.ts`, `apps/agent/src/index.ts`, `apps/swift/NexusShared/Models/CcProfile.swift`, `apps/swift/NexusShared/Networking/NexusClient.swift`, `apps/swift/NexusShared/Networking/NexusAggregateClient.swift`, `apps/swift/nexus-mac/Sources/Dashboard/CredentialsView.swift`

NexusClient + NexusAggregateClient shared with four prior session-scaffolded
specs. wave-plan-build will serialize the wave; the changes are append-only
new methods.

`apps/agent/src/credentials/pool/pool-core.ts` is touched to expose the
`probeIdentity()` method publicly so the refresh-identity handlers can
call it. Currently it's `private`. Existing call site
(constructor-time probe on `add`) is unaffected.

## Risk

- **Anthropic rate-limit from poller.** 5-minute interval × N credentials
  × per-credential /api/oauth/usage call. With 20 credentials, that's
  240 calls/hour to a single Anthropic endpoint. Mitigation: poller
  concurrency capped at 4, per-call 10s timeout, error counter — if
  >50% calls fail in a single tick, back off to 30 minutes for the
  next tick. Manual override env var `NEXUS_USAGE_POLL_INTERVAL_MS`.
- **Usage response shape unknown / unstable.** Anthropic's
  /api/oauth/usage is an internal OAuth endpoint; the response shape
  isn't documented. Mitigation: defensive parsing via Zod-style
  schema validation — keys we recognise get persisted, unknown keys
  pass through. On parse failure, log + count + don't update the row
  (don't clobber existing data). The probe-credential-identity.ts
  script can be re-used to inspect the actual response.
- **Dedupe hiding important info.** If two credentials in a group
  have diverged status (one healthy, one revoked), `?dedupe=true`
  shows only the primary. Mitigation: the primary row's
  `siblingIds[]` field lets the UI render a small "siblings disagree"
  badge when needed. Out-of-scope to surface in v1; the dashboard
  toggle defaults ON so the user opts into the collapsed view.
- **Schema migration on big credential tables.** Adding 7 nullable
  columns on a ~50-row table is trivial. Mitigation: nothing
  needed at this scale; if/when credentials table grows, the
  migration would still complete in seconds since columns are
  NULLABLE (no rewrite).

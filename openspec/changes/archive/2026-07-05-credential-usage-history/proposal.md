# Credential Usage History — restore the `credential_polls` time-series

## Context
- touches: `packages/db/src/schema/credentialPolls.ts`, `packages/db/src/schema/index.ts`, `apps/agent/src/services/credential-usage-poller.ts`, `apps/agent/src/services/cron.ts`, `apps/agent/src/routes/credentials/handlers-health-usage.ts`, `apps/agent/src/routes/credentials/index.ts`, `packages/core/src/types/account.ts`, `packages/core/src/index.ts`, `apps/swift/NexusShared/Networking/NexusClient.swift`, `apps/swift/NexusShared/Models/CcProfile.swift`, `apps/swift/nexus-mac/Sources/Dashboard/CredentialsView.swift`, `apps/swift/nexus-mac/Sources/Dashboard/CredentialsUsageHistoryChart.swift`

## Why

The `credential-analytics` capability already specifies a `credential_polls` time-series
("write per-account utilization to `credential_polls` on each 5-minute poll"), but that table
was lost in the 2026-04-03 SQLite→Postgres migration. Today `credential-usage-poller.ts`
**overwrites** the seven `usage5h*/usage7d*` columns on `credentials` every tick — the Mac
dashboard can render the *current* 5h/7d bar but there is no history, so no trend, no
"which window is filling up faster", no post-hoc "when did this account get throttled".

The homelab agent already polls Anthropic `/api/oauth/usage`; we just discard everything but
the latest snapshot. This restores the specified append-only history and surfaces a trend on
the existing Mac UI.

## What Changes

1. **DB** — new `credential_polls` append-only table (mirrors `health_snapshots` shape +
   the weekly reaper retention pattern). One row per polled account per successful tick.

2. **Agent (homelab)** — the usage poller, after its existing current-state overwrite,
   inserts one `credential_polls` row per successful poll. The weekly cron reaper prunes
   rows older than 30 days (folded into the existing `runReaperJob`, no new cron job).

3. **API** — `GET /credentials/:id/usage-history?window=5h|7d&sinceHours=N` returns the
   ordered point series for one account. New handler beside the existing
   `handlers-health-usage.ts`, registered in the credentials router.

4. **UI (Mac only)** — a compact Swift Charts sparkline of utilization-over-time per account
   in `CredentialsView`, fed by a new `NexusClient.fetchUsageHistory`. The Mac is the display
   layer only; all collection/persistence stays on the homelab agent.

## Out of Scope

- iOS / watchOS surfaces (no credential UI there today; not requested).
- Per-session account attribution / usage-over-time granularity beyond the poll cadence.
- Cross-account / fleet rollups and limit-exhaustion alerting.
- Reviving the dead `cc_profiles` / `CcCredentialManager` subsystem.
- Polling non-primary duplicate credentials (poller scope unchanged: `is_primary AND available`).

# Design — credential-usage-history

## Table shape (`credential_polls`)

Mirrors `health_snapshots` (append-only time-series + indexed timestamp for the reaper).
One row per polled account per successful tick.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | integer identity PK | same idiom as `health_snapshots.id` |
| `credential_id` | text, FK → `credentials.id` `onDelete: cascade` | the polled row |
| `fingerprint` | text notNull | account grouping (survives dedupe/file churn) |
| `usage_5h_used` / `usage_5h_limit` | integer | copied from the parsed poll payload |
| `usage_7d_used` / `usage_7d_limit` | integer | |
| `usage_5h_reset_at` / `usage_7d_reset_at` | timestamptz nullable | window reset instants |
| `polled_at` | timestamptz notNull | observation instant (the series x-axis) |

Indexes: `(credential_id, polled_at)` for per-account reads, `(polled_at)` for the reaper.

## Write path

`credential-usage-poller.ts` → `writeSnapshot()` already runs on each successful poll and
updates the current-state columns on `credentials`. Add one `INSERT INTO credential_polls`
in the same function, right after the existing update, inside the same success branch. No
change to poll cadence, concurrency, or the `is_primary AND available` selection.

## Retention

Fold a `DELETE FROM credential_polls WHERE polled_at < now() - interval '30 days'` into the
existing weekly `runReaperJob` (Sun 03:00). No new cron job.
<!-- ponytail: 30d fixed retention; make it an env var only if someone asks for a different window -->

## Read path

`GET /credentials/:id/usage-history?window=5h|7d&sinceHours=N` (default `window=5h`,
`sinceHours=24`). `window` selects the `used`/`limit` column pair; returns
`{ points: [{ polledAt, used, limit }] }` ordered by `polled_at ASC`. New handler next to
`handlers-health-usage.ts`, wired in `routes/credentials/index.ts`.

## UI (Mac only)

`CredentialsUsageHistoryChart.swift` — Swift Charts `LineMark` over `[UsageHistoryPoint]`
(x = `polledAt`, y = `used/limit` ratio), rendered under the existing `CredentialsUsageBar`
in `CredentialsView`. Data via `NexusClient.fetchUsageHistory(id:window:)`. State-free like
`CredentialsUsageBar`; caller supplies points.

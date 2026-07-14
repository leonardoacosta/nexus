# Design: Redesign Status/Usage API Surface

## Response contract

`GET /statusline?sessionId=<id>&accountId=<id>`

| sessionId | accountId | Response |
|---|---|---|
| absent | absent | `{ accounts: Account5H7D[] }` — all known accounts |
| absent | present | `{ account: Account5H7D }` — one account, 404 if unknown |
| present | absent | `{ session: SessionStatus }` — one session, 404 if unknown |
| present | present | `400 { error: "sessionId and accountId are mutually exclusive" }` |

```ts
interface Account5H7D {
  accountId: string;
  fiveHour: { used: number; limit: number; resetsAt: string | null };
  sevenDay: { used: number; limit: number; resetsAt: string | null };
}

interface SessionStatus {
  sessionId: string;
  model: string | null;              // single-letter family tag, existing modelFamilyLetter()
  fiveHour: Account5H7D["fiveHour"] | null;   // via session's active credentialId, null if unresolved
  sevenDay: Account5H7D["sevenDay"] | null;
  usage: { cost_usd: number | null; input: number; output: number; cache_read: number; cache_creation: number };
  project: {
    beadsReadyUnlinked: number;
    beadsBlockedUnlinked: number;
    proposalsUnarchived: number;
    git: GitStatusObject | null;
  } | null;                          // null when session has no resolvable project
  next: NextRecommendation | null;   // existing GET /recommend shape, unchanged
}
```

No existing `sessions[]`/`git`/`machine`/`uptime_seconds` fields are removed from the neither-mode
response — this is additive to today's `GET /statusline` (all-active-sessions overview), not a
breaking replacement of it. The new `sessionId`/`accountId` params add two new *narrowed* response
shapes; when neither param is present, behavior is unchanged from today plus whatever fields the
UI Batch decides to backfill onto the existing `sessions[]` entries (see task 2.1 note).

## Key joins (all pre-existing, no new FKs)

1. **Session → account (5H/7D + usage)**: `sessions.credentialId` (already denormalized, not
   FK-enforced — same "avoid Neon issues" pattern as `session_token_turns.credential_id`) →
   `credentials.usage5hUsed/Limit/ResetAt`, `usage7dUsed/Limit/ResetAt`.
2. **Session → project (beads/openspec/git)**: `sessions.projectId` (uuid) → `projects.name`
   (text) → `project_status_snapshots.project` (text, matches `projects.name` per existing
   `spec-timeseries` keying convention — "deliberately NOT the projects uuid"). Latest snapshot
   row only; no live shell-out.
3. **Session → cost usage**: `sessionId` directly, via `readSessionCostTokens(vm, sessionId)`
   (`apps/agent/src/telemetry/session-cost-read.ts`) — already handles the disabled-VM case by
   returning the zero/null `EMPTY` breakdown, so this composes without a new failure mode.

## Caching

Reuse the existing pattern in `apps/agent/src/routes/statusline.ts` (`getGitStatusCached`, 5s TTL)
rather than inventing new caching per source:

- Account 5H/7D and project beads/openspec/git are already snapshot-cached upstream
  (`credentialPolls`/`project_status_snapshots` are written by background pollers/watchers, not
  computed per-request) — the route only needs a fast Postgres read, no new TTL layer required.
- `readSessionCostTokens` issues a live VictoriaMetrics query per call. If this proves too slow
  under real polling cadence (nexus-statusline polls every few seconds per its existing
  `getGitStatusCached` precedent), apply the same 5s-TTL pattern keyed by `sessionId`. Task 2.4
  ships without this cache first and adds it only if a real latency problem is observed —
  YAGNI per the Reader Gate, not preemptive.

## Dead-column cleanup

`sessions.total_cost_usd` (migration 0005) and every write site that sets it to `null`
(`session-manager.ts`, `process-watcher.ts`, `routes/sessions.ts`, `stub-agent.ts`) are removed.
The `session-persistence` spec's "Sessions table populates total_cost_usd from session_summary"
requirement documented an approach that was superseded by the VictoriaMetrics telemetry path
(`cc-telemetry-read`) before ever being fully wired — the column never held a real value in
production. This is a straight deletion, not a migration (no data to preserve — every row's value
is `null`).

## Known open drift (not resolved by this proposal)

- `credential-http-endpoint` spec describes a pre-Bun-migration Rust API (port 7401,
  `X-Nexus-Secret` header, `active_account`/`best_available`/`debounce_active` fields) that does
  not match the shipped `packages/core/src/types/account.ts` `Account`/`WireCredentialRow` shapes.
  Left untouched; flagged for a separate spec-hygiene proposal.
- `credential-analytics`' `GET /credentials/{id}/usage?window=1h|6h|24h|7d` requirement (token-turn
  rollup shape: `input_tokens`/`output_tokens`/`cost_usd`/`turn_count`) and `credential-page-status`'s
  `GET /credentials/{id}/usage?window=5h` requirement (percent/resetsAt shape) describe the same
  URL with two incompatible response shapes. Could not resolve which (if either) matches the
  current handler — `apps/agent/src/routes/credentials/handlers-health-usage.ts` is outside this
  session's Read/Bash permission scope (global `*credentials*` deny rule). This proposal's
  `accountId`-mode delta is scoped only to the verified-in-code `Account.usagePercent`/`resetsAt`
  fields (`packages/core/src/types/account.ts`, confirmed by direct read); the conflicting
  `?window=` endpoint is explicitly out of scope. `[user]` task 2.6 asks Leo to resolve which shape
  is real before that specific endpoint is touched by any future spec.

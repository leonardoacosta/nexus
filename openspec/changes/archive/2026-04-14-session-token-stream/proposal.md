# Proposal: Per-Session, Per-Turn Token Streaming with Credential Attribution

## Change ID
`session-token-stream`

## Summary
Tail each active Claude Code session's transcript JSONL file incrementally, emit
per-turn token records attributed to the credential that was leased at the turn's
timestamp, and expose the resulting data via HTTP so operators can answer
"session X cost Y tokens against credential Z, with a mid-session swap splitting
tokens between Z and W." Replaces the current coarse 5-minute `/api/oauth/usage`
polling as the authoritative answer for per-session spend.

## Why
Nexus already persists `credential_polls` every 5 minutes from the Anthropic
usage API, which tells operators the aggregate 5h/7d utilization per credential
but not which sessions consumed those tokens. Meanwhile Claude Code writes a
full transcript JSONL for every session to
`~/.claude/projects/<encoded-cwd>/<cc_session_id>.jsonl`, including
`message.usage.{input_tokens, output_tokens, cache_creation_input_tokens,
cache_read_input_tokens, service_tier}` and `message.model` on every turn. That
data is sitting on disk, unharvested.

We want live, per-turn accounting so:

1. A session detail view can show "this session burned 47k input / 32k output
   tokens and cost $0.84, split between credential A (before rotation) and
   credential B (after)."
2. A credential detail view can roll up all sessions and turns that hit a given
   credential (or duplicate group) over a window, using real usage data — not
   the blurry 5-minute poll.
3. A mid-session credential swap is attributed correctly: turns before the swap
   timestamp stay on the outgoing credential, turns after the swap go to the
   incoming credential, with no retroactive re-mapping.

## What Changes

- **BREAKING (schema)** Extend `sessions` table with two nullable columns:
  `credential_id TEXT NULL` (FK to `credentials.id`) and `credential_fingerprint
  TEXT NULL`. Set at `session_start` from the pool's current lease state. Both
  are NULL when tracking cannot attach (no lease, no transcript, etc.).
- **NEW table** `session_token_turns` — one row per parsed transcript turn with
  tokens, model, service tier, computed cost, and the credential that was
  active at that turn's timestamp. Unique constraint `(session_id, ts)` is the
  dedup safety net for re-reads after agent restart.
- **NEW table** `session_token_watcher_state` — per-session tail bookkeeping
  (`transcript_path`, `byte_offset`, `updated_at`) so the watcher resumes at
  the correct offset after an agent restart.
- **NEW service** — on `session_start`, compute the transcript path, wait up to
  5 seconds for the file to exist (via parent-directory `fs.watch`), then attach
  a tail reader. Parse each newline-delimited JSON line, extract usage, attribute
  to the credential active at that turn's timestamp, compute cost from a
  hardcoded model price table, insert into `session_token_turns`, and advance
  the watcher offset.
- **NEW file** `apps/agent/src/credentials/model-pricing.ts` — typed const map
  of `model → { input_rate, output_rate, cache_read_rate, cache_creation_rate }`.
  Unknown models produce `cost_usd = NULL` and a warn-once log.
- **NEW endpoint** `GET /sessions/{id}/tokens` — turn-level array plus aggregate
  totals (tokens, cost) for a single session.
- **NEW endpoint** `GET /credentials/{id}/usage?window=24h` — aggregates
  `session_token_turns` by `credential_fingerprint` (not `credential_id`, so
  duplicates in the same group roll up together) over a time window.
- **NEW event** `token.turn` — emitted on the existing notification/socket bus
  after each parse batch with `{session_id, credential_id,
  credential_fingerprint, tokens_delta, cost_delta}`. Append-only, no replay.
- Lifecycle integration: watchers start on `session_start`, stop on
  `session_stop`, and resume from stored offsets on agent restart.

## Depends On

- **`credential-identity`** — this proposal denormalizes
  `credential_fingerprint` onto `sessions` and `session_token_turns` so
  credential-level rollups survive duplicate-group collapse. The
  `credentials.fingerprint` column is introduced by the `credential-identity`
  change and MUST land first. Sequencing: apply `credential-identity`, then
  apply `session-token-stream`.
- The `credential_swaps` table (from `credential-analytics`) already exists and
  is the source of truth for intra-session attribution at turn-insert time.

## Impact

### Affected specs
- `session-persistence` (modified — adds credential denormalization + token
  streaming requirements to existing session schema)
- `credential-analytics` (modified — adds `session_token_turns` and
  `session_token_watcher_state` tables and the per-session rollup endpoint)

### Affected code
- `packages/db/src/schema/sessions.ts` — new `credential_id`,
  `credential_fingerprint` columns
- `packages/db/src/schema/credential-analytics.ts` (or equivalent) — new
  `session_token_turns` and `session_token_watcher_state` tables
- `packages/db/drizzle/*` — generated migration
- `apps/agent/src/credentials/model-pricing.ts` — **new** typed price table
- `apps/agent/src/credentials/token-stream/transcript-locator.ts` — **new**
  path computation + parent-watch debounce
- `apps/agent/src/credentials/token-stream/tail-watcher.ts` — **new** tail
  reader + parser + attribution join + cost calculator
- `apps/agent/src/credentials/token-stream/lifecycle.ts` — **new** start/stop
  hooks wired into session events and restart replay
- `apps/agent/src/routes/sessions.ts` — new `GET /sessions/{id}/tokens` handler
- `apps/agent/src/routes/credentials.ts` — new `GET /credentials/{id}/usage`
  handler
- `apps/agent/src/notifications/*` — `token.turn` event shape
- `apps/agent/src/**/*.test.ts` — unit + integration coverage

## Out of Scope

- **Cross-agent token rollup.** The dashboard layer will aggregate across
  multiple agents by calling each agent's `/credentials/{id}/usage` endpoint;
  that's a UI concern, not an agent concern.
- **Token budget alerts / pre-rotation based on per-session spend.** The
  existing 5h/7d threshold-based pre-rotation stays as-is. Spending-based
  triggers are future work.
- **Cost accuracy for new Anthropic models.** The hardcoded price table is a
  known trade-off — updating prices requires a code change and redeploy.
- **Backfilling historical sessions' transcripts.** Only sessions that start
  after this change is applied are tracked. Historical data stays in
  `credential_polls`.
- **UI / dashboard changes.** Consumers query the new endpoints unchanged; any
  UI work is a separate proposal.

## Risks

| Risk | Mitigation |
|------|-----------|
| Transcript file doesn't exist yet at `session_start` | 5-second parent-directory `fs.watch` with WARN-and-skip fallback; session still works, just no token data |
| Agent crashes mid-batch, offset lost | `UNIQUE(session_id, ts)` rejects duplicate inserts on resume; offset updated after each insert batch (not each line) |
| Turn parsed at T-ε just before a swap at T gets the wrong credential | Committed at turn-insert time using `credential_swaps` state at that moment; accepted as a known ±1-turn fuzz — see design.md |
| Model pricing drifts | Documented known trade-off; unknown model → `cost_usd = NULL` + warn-once; price table update is a code change |
| Transcript path collision (same cwd + cc_session_id) | CC session IDs are UUIDs; collision probability negligible. `UNIQUE(session_id, ts)` is the belt-and-braces safety net |

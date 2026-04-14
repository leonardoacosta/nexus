# Design: Session Token Stream

## Context

Claude Code writes a full conversation transcript JSONL file per session to
`~/.claude/projects/<encoded-cwd>/<cc_session_id>.jsonl`, where the encoded
cwd substitutes `-` for `/`. Each newline-delimited line is a JSON object
containing `timestamp`, `message.model`, and `message.usage` with
`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`, and `service_tier`. This is the authoritative source
of per-turn token counts.

Nexus currently polls the Anthropic usage API every 5 minutes
(`credential_polls` table) to track aggregate credential utilization. That is
enough to trigger pre-rotation at 85% of the 5-hour bucket but tells operators
nothing about which sessions consumed those tokens.

This proposal closes the gap with a per-session tail-and-stream watcher that
attributes turns to credentials using the existing `credential_swaps` table
as the source of truth for intra-session rotations.

## Goals / Non-Goals

Goals:
- Per-session, per-turn token accounting with model + service tier captured.
- Credential attribution that stays correct across mid-session swaps.
- Fingerprint-level rollups so duplicate-group members aggregate together.
- Live stream via the existing notification bus so dashboards can update
  in-flight.
- Resume-safe across agent restarts using a persisted byte offset.

Non-Goals:
- Cross-agent rollup (dashboard concern).
- Token-budget-based pre-rotation (future work).
- Retro-attribution of turns that raced with a swap (see Decision 4).
- Backfilling historical sessions from transcripts that predate the change.
- Dynamic model price lookups (see Decision 3).

## Decisions

### Decision 1 — Tail-and-stream, not scan-on-stop

**Choice:** Watch each active session's transcript JSONL incrementally via
`fs.createReadStream` + `fs.watch`, parsing each newline-delimited line as it
arrives. Rejected: scan the full file at `session_stop` and insert all turns in
one pass.

**Rationale:**
- Live per-session token counters enable real-time dashboards and the
  `token.turn` notification stream.
- A scan-on-stop design silently drops data for any session that never
  receives a stop event (agent crash, kill -9, tmux detach).
- Tail-and-stream matches the existing lifecycle (session_start / session_stop)
  without adding a "replay on shutdown" bulk job.

### Decision 2 — Per-swap attribution at turn-insert time

**Choice:** When inserting a turn row, look up
`credential_swaps WHERE session_id = ? AND swapped_at <= turn.ts ORDER BY
swapped_at DESC LIMIT 1`. If no swap matches, fall back to
`sessions.credential_id` (the initial lease at `session_start`). Store the
resolved `credential_id` and `credential_fingerprint` on the turn row
immediately.

**Rationale:**
- A long session spanning a rotation naturally splits: turns before
  `swapped_at` attach to the outgoing credential, turns after attach to the
  incoming one.
- The fingerprint denormalization means duplicate-group rollups work without
  a JOIN through `credentials` at read time.
- Denormalizing at write time means the `credential_id` on the turn row is a
  point-in-time fact that survives `credentials` table mutations (delete,
  promote).

Alternatives considered:
- Join at read time (`session_token_turns` → `credentials` via swap history):
  rejected — makes every query O(N swaps) and couples read path to a mutable
  joining table.
- Async re-attribution pass: rejected — more moving parts, no clear trigger.

### Decision 3 — Hardcoded model pricing

**Choice:** A typed const map in `apps/agent/src/credentials/model-pricing.ts`
with entries per known Anthropic model. Cost is computed at turn-insert time
as `input * in_rate + output * out_rate + cache_read * cache_read_rate +
cache_creation * cache_creation_rate`. Unknown models → `cost_usd = NULL` and
a warn-once log per `(session_id, model)` pair.

**Rationale:**
- Anthropic does not expose a pricing API; any runtime lookup would either be
  a scraper (fragile) or require an external config service (over-engineered).
- A hardcoded table is boring, testable, and self-documenting in git history.
- NULL cost on unknown models preserves accurate token counts even when
  pricing is missing — the dashboard can display "tokens: 47k, cost:
  unknown" rather than dropping the turn entirely.

**Known trade-off:** New Anthropic models require a code change + redeploy
before their cost is computed. This is documented in the proposal under
"Out of Scope" and accepted.

### Decision 4 — Retro-attribution is explicitly not supported

A credential swap lands in `credential_swaps` at time T. A turn parsed and
inserted at time T-ε carries whatever the swap state looked like at T-ε, even
if a swap row is committed moments later. We do not reprocess committed turns.

**Rationale:**
- The fuzz window is at most one turn (the one being parsed during the swap).
- The credential pool's own debounce window (3 minutes) means swaps are rare
  compared to turn cadence, so the frequency of ±1-turn fuzz is low.
- A one-shot SQL fix-up script can retroactively correct historical turns if
  this ever matters for an audit — deferring that complexity until there's a
  concrete reason.
- Adding background re-attribution would introduce a second writer to the
  table, complicating concurrency and breaking the append-only contract of
  the `token.turn` event stream.

### Decision 5 — Transcript path race handled by parent-directory watch

**Choice:** On `session_start`, attempt to open the transcript file
immediately. If it doesn't exist, attach `fs.watch` (non-recursive) on the
parent directory `~/.claude/projects/<encoded-cwd>/` with a 5-second timeout.
On file-creation event, attach the tail reader. On timeout, log WARN and skip
token tracking for that session (the session itself still runs; just no token
data flows).

**Rationale:**
- Claude Code buffers some session metadata before the first user turn, so
  the JSONL file may lag `session_start` by hundreds of milliseconds.
- 5 seconds is a generous upper bound that tolerates disk / CC startup jitter
  without blocking the session lifecycle.
- WARN-and-skip is the correct degraded mode: missing token data is preferable
  to a crashed session.

### Decision 6 — Byte offset persisted per batch, not per line

**Choice:** Update `session_token_watcher_state.byte_offset` after each
successful insert batch (typically N turns), not after each parsed line. The
`UNIQUE(session_id, ts)` constraint on `session_token_turns` is the safety net
for duplicate inserts when an offset update is lost mid-crash.

**Rationale:**
- Per-line offset updates would triple the write volume for no reliability
  gain — the UNIQUE constraint already handles resume dedup.
- Per-batch updates amortize the offset write across N turns.
- The insert batch and the offset update run in a single transaction so
  either both land or neither does.

### Decision 7 — Transcript path collision accepted as negligible

**Choice:** Two CC runs sharing cwd + cc_session_id would collide on the
transcript path. CC session IDs are UUIDs generated by Claude Code; the birthday
bound on UUID4 collision is astronomical for realistic session counts.
`UNIQUE(session_id, ts)` provides a safety net in the (practically impossible)
collision case.

**Rationale:**
- Documented as "accepted risk" per the requirements.
- No code complexity added to handle the impossible case.

## Risks / Trade-offs

| Risk | Mitigation |
|------|-----------|
| High-frequency turn writes during a burst of parallel sessions stress SQLite | Batched inserts per file-watch event (already a natural batch boundary), single transaction per batch; measured-first if latency becomes an issue |
| Model pricing drift silently undercharges the rollup view | Warn-once log per unknown model surfaces the gap in operator-visible logs; fixed by a code update |
| `fs.watch` on macOS vs Linux has different reliability characteristics | Reader re-scans from stored offset on each watch event, so missed events eventually catch up at the next event; we do not rely on watch events for correctness beyond "wake up eventually" |
| `credential_fingerprint` NULL for sessions that started before `credential-identity` landed | Migration order enforces `credential-identity` first; new sessions always have a fingerprint if a lease is held at `session_start` |

## Migration Plan

1. Apply `credential-identity` change first so `credentials.fingerprint` exists.
2. Apply this change's schema migrations: sessions columns, `session_token_turns`
   table, `session_token_watcher_state` table, indexes.
3. Deploy the new watcher code alongside the migration. Existing active sessions
   at deploy time will not have transcripts tracked (no `session_start` fires
   on an already-running session) — they will fall into the "only new sessions
   are tracked" out-of-scope category and flush their tokens via the old
   `credential_polls` path until they end naturally.
4. After deploy, verify `session_token_turns` is receiving rows and
   `GET /sessions/{id}/tokens` / `GET /credentials/{id}/usage` return expected
   data before any UI wiring lands.

Rollback: drop the two new tables, revert the `sessions` columns, revert the
code. No data loss on other tables because the new tables are independent.

## Open Questions

None — all questions in the brief have been resolved above.

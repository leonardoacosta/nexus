# Implementation Tasks

<!-- beads:epic:nx-u2m9a -->
<!-- beads:feature:nx-khcep -->

> Beads filed after Leo approves the proposal.

## DB Batch

- [x] [1.1] [P-1] Add startup migration that retires stranded sessions: `UPDATE sessions SET status='ended', ended_at=DATETIME(started_at, '+8 hours') WHERE started_at < '2026-04-24T00:00:00Z' AND status='active'` — idempotent on re-run [owner:db-engineer] [type:infra] [beads:nx-xecl2]

## API Batch

- [x] [2.1] [P-1] Replace `handleHooks` no-op stub in `apps/agent/src/routes/hooks.ts` with actual persistence. For every recognized event, INSERT into `events` table before returning 200 [owner:api-engineer] [type:code] [beads:nx-cmffc]
- [x] [2.2] [P-1] Add `session_start` handling: INSERT into `sessions` with `status='active'`, `started_at`, `model`, `cwd`, `branch`, `project`, `cc_session_id`. ON CONFLICT (id) UPDATE metadata fields [owner:api-engineer] [type:code] [beads:nx-1b7r7]
- [x] [2.3] [P-1] Add `session_summary` handling: read `cost_usd`, `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` from payload. UPDATE `sessions.total_cost_usd` (overwrite). If `cost_usd` absent, compute server-side from token counts + `model` using model-aware rates table [owner:api-engineer] [type:code] [beads:nx-g1olz]
- [x] [2.4] [P-1] Add `session_stop` handling: UPDATE `sessions SET ended_at=NOW(), status='ended' WHERE id=:session_id` [owner:api-engineer] [type:code] [beads:nx-pyofn]
- [x] [2.5] [P-1] Add `stop_failure` handling: UPDATE `sessions SET status='errored', ended_at=NOW() WHERE id=:session_id`. Persist `stop_reason` in events row data column [owner:api-engineer] [type:code] [beads:nx-qxt7y]
- [x] [2.6] [P-2] Implement model-aware cost computation helper. Lookup table for opus-4-7, opus-4-6, sonnet-4-6, haiku-4-5. Inputs: token counts; output: cost_usd [owner:api-engineer] [type:code] [beads:nx-5ovkw]
- [x] [2.7] [P-3] Accept `diagnostic_ping` event type. Same write path as other events. Returns 200 with the event row's id for round-trip verification [owner:api-engineer] [type:code] [beads:nx-zsyce]

## UI Batch

(none — this is a pure backend persistence fix)

## E2E Batch

- [x] [3.1] [P-1] Integration test in `apps/agent/src/routes/hooks.test.ts`: POST a `session_start` payload, query events table, assert row exists. Repeat for `session_summary` (assert sessions table updated), `session_stop` (assert ended_at set), `stop_failure` (assert status='errored') [owner:test-writer] [type:testing] [beads:nx-z7vha]
- [x] [3.2] [P-2] Smoke test: deploy the fix, send a `diagnostic_ping`, confirm row appears in DB within 1 second [owner:test-writer] [type:testing] [beads:nx-j5249]
- [ ] [3.3] [P-2] [user] After deploy, run a real `/apply` invocation in any registered project, confirm the session's `total_cost_usd` populates within 30s of session end [owner:user] [type:testing] [beads:nx-f0pdx]
- [ ] [3.4] [P-3] [user] Verify the stranded-session migration ran by checking `SELECT COUNT(*) FROM sessions WHERE status='active' AND started_at < '2026-04-24'` returns 0 [owner:user] [type:testing] [beads:nx-k2asp]

<!-- beads:epic:nx-xg67 -->
# Implementation Tasks

## 1. Database Layer

- [x] 1.1 Add `credential_id TEXT NULL` (FK `credentials.id`) and `credential_fingerprint TEXT NULL` columns to `sessions` in `packages/db/src/schema/sessions.ts`; generate migration [beads:nx-9eq3]
- [x] 1.2 Create `session_token_turns` table (`id` PK, `session_id` FK, `ts`, `model`, `service_tier`, `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `cost_usd`, `credential_id`, `credential_fingerprint`, `UNIQUE(session_id, ts)`) with indexes on `(credential_fingerprint, ts)` and `(session_id)`; generate migration [beads:nx-dln8]
- [ ] 1.3 Create `session_token_watcher_state` table (`session_id` PK, `transcript_path`, `byte_offset` BIGINT DEFAULT 0, `updated_at`); generate migration [beads:nx-lu51]
- [ ] 1.4 Create `apps/agent/src/credentials/model-pricing.ts` with a typed const map `model → { input_rate, output_rate, cache_read_rate, cache_creation_rate }` covering the current Anthropic catalog [beads:nx-m297]

## 2. Service Layer — Transcript Discovery

- [ ] 2.1 Implement `transcript-locator.ts` — compute `~/.claude/projects/${cwd.replaceAll('/', '-')}/${cc_session_id}.jsonl`, return the path if it exists, otherwise attach an `fs.watch` on the parent directory with a 5s timeout [beads:nx-mkxe]
- [ ] 2.2 On timeout, log WARN once and return null so the caller can skip tracking without failing the session [beads:nx-1kdq]

## 3. Service Layer — Tail Watcher

- [ ] 3.1 Implement `tail-watcher.ts` — open `fs.createReadStream(path, { start: byte_offset })`, buffer partial lines, parse each newline-delimited JSON, skip lines without `message.usage` [beads:nx-8tl4]
- [ ] 3.2 Extract `{ts: message.timestamp, model: message.model, service_tier: message.usage.service_tier, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` per turn [beads:nx-vgfi]
- [ ] 3.3 Subscribe to `fs.watch` on the transcript path for subsequent append events; re-enter the read loop on each signal [beads:nx-n0j0]

## 4. Service Layer — Credential Attribution

- [ ] 4.1 Implement `attributeTurnToCredential(sessionId, turnTs)` — query `credential_swaps WHERE session_id = ? AND swapped_at <= ? ORDER BY swapped_at DESC LIMIT 1`, falling back to `sessions.credential_id` if no swap matches [beads:nx-1jow]
- [ ] 4.2 Return both `credential_id` and `credential_fingerprint` (join against `credentials` for the fingerprint lookup) [beads:nx-8ypu]

## 5. Service Layer — Cost Calculator

- [ ] 5.1 Implement `computeCost(model, usage)` using the `model-pricing.ts` map; return `null` and log WARN-once per `(session_id, model)` pair when the model is unknown [beads:nx-x138]

## 6. Service Layer — Lifecycle & Persistence

- [ ] 6.1 Implement `startWatcher(session)` — invoked on `session_start`; sets `sessions.credential_id` and `sessions.credential_fingerprint` from the pool's current lease, then begins tail watching [beads:nx-sgw4]
- [ ] 6.2 Implement `stopWatcher(sessionId)` — invoked on `session_stop`; flushes any pending batch and closes streams [beads:nx-1vgr]
- [ ] 6.3 On each successful insert batch, update `session_token_watcher_state.byte_offset` and `updated_at` in a single transaction with the turn inserts [beads:nx-um4w]
- [ ] 6.4 On agent startup, load `session_token_watcher_state` rows for still-active sessions and resume tail watching from the stored offsets [beads:nx-uay7]

## 7. API Layer

- [ ] 7.1 Implement `GET /sessions/{id}/tokens` in `apps/agent/src/routes/sessions.ts` — return `{ turns: [...], aggregates: { input, output, cache_creation, cache_read, cost_usd, turn_count } }` [beads:nx-a8zn]
- [ ] 7.2 Implement `GET /credentials/{id}/usage?window=24h` in `apps/agent/src/routes/credentials.ts` — look up target credential's fingerprint, aggregate `session_token_turns` over the window filtered by `credential_fingerprint`, return `{ input, output, cache_creation, cache_read, cost_usd, turn_count, session_count }` [beads:nx-kat0]
- [ ] 7.3 Validate `window` parameter as one of `1h`, `6h`, `24h`, `7d`; return 400 on unrecognized values [beads:nx-pqd2]

## 8. API Layer — Live Stream

- [ ] 8.1 Emit `token.turn` events on the existing notification/socket bus after each successful insert batch with `{session_id, credential_id, credential_fingerprint, tokens_delta, cost_delta}` (event is append-only, no replay) [beads:nx-xw8f]

## 9. Tests — Unit

- [ ] 9.1 Unit test `transcript-locator` — file exists immediately, file appears within 5s window, timeout path returns null [beads:nx-t7zi]
- [ ] 9.2 Unit test `attributeTurnToCredential` — pre-swap turn maps to initial credential, post-swap turn maps to swap target, no-swap fallback uses `sessions.credential_id` [beads:nx-etv8]
- [ ] 9.3 Unit test `computeCost` — known model yields deterministic USD, unknown model returns null and logs warn-once [beads:nx-31kt]

## 10. Tests — Integration

- [ ] 10.1 Integration test: feed a fixture JSONL transcript through the tail watcher end-to-end, assert `session_token_turns` rows match and aggregates are correct [beads:nx-zmup]
- [ ] 10.2 Integration test: simulate a mid-session `credential_swaps` row and assert turns before/after the swap timestamp are attributed to the correct credential [beads:nx-z551]
- [ ] 10.3 Integration test: write N turns, stop the watcher mid-stream, restart the lifecycle loop, and assert the resume offset skips already-inserted rows (UNIQUE constraint never fires) and the new tail picks up the remaining lines [beads:nx-lgb5]
- [ ] 10.4 Integration test: `GET /sessions/{id}/tokens` returns turns and aggregates; `GET /credentials/{id}/usage?window=24h` rolls up by fingerprint across duplicate-group members [beads:nx-vbzh]

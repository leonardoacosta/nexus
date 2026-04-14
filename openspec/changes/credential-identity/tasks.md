<!-- beads:epic:nx-i0uy -->
# Implementation Tasks

## 1. DB Schema

- [x] 1.1 Add `fingerprint TEXT NOT NULL`, `duplicate_group_id TEXT`, `is_primary BOOLEAN NOT NULL DEFAULT false` columns to `packages/db/src/schema/credentials.ts` [beads:nx-l9oo]
- [x] 1.2 Add index on `credentials.fingerprint` and composite index on `(duplicate_group_id, is_primary)` [beads:nx-3mdm]
- [x] 1.3 Generate Drizzle migration (`pnpm --filter @nexus/db db:generate`) with the new columns defaulted so the migration is append-only at the SQL level [beads:nx-zc0a]
- [x] 1.4 Write backfill SQL/TS step: for each existing row, decrypt the stored value, compute SHA-256 of the parsed refresh token, set `fingerprint` and `duplicate_group_id = fingerprint`, mark the newest `updated_at` row per group `is_primary = true` (tiebreak: alphabetical `name`) [beads:nx-qpbh]
- [x] 1.5 Degraded-row handling in backfill: rows whose value fails to parse as OAuth JSON get `fingerprint = 'UNKNOWN-' || id`, `is_primary = true`, and a WARN log [beads:nx-z2gg]

## 2. Service — Fingerprint Helper

- [x] 2.1 Add `computeCredentialFingerprint(plaintext: string): string` to `apps/agent/src/credentials/credentials.helpers.ts` — parses JSON, extracts `claudeAiOauth.refreshToken`, returns SHA-256 hex; throws `CredentialParseError` if malformed [beads:nx-6nm4]
- [ ] 2.2 Unit-test the helper: valid OAuth JSON, missing `claudeAiOauth`, missing `refreshToken`, non-JSON input, ensures deterministic hex output for identical tokens [beads:nx-bpue]

## 3. Service — Pool Integration

- [x] 3.1 `CredentialPool.add()` computes fingerprint from plaintext before encryption and stores it in the insert; if an existing row shares the fingerprint, the new row is inserted with `is_primary = false` and joined to the existing group [beads:nx-2f1a]
- [ ] 3.2 `CredentialPool.add()` promotes the new row to `is_primary = true` when its mtime is newer than the current primary of the group (group's previous primary is demoted in the same transaction) [beads:nx-om1o]
- [ ] 3.3 `CredentialPool.lease()` adds `and(eq(credentials.isPrimary, true))` to its candidate predicate; non-primary rows are unreachable via lease [beads:nx-wgr6]
- [ ] 3.4 Add `CredentialPool.promote(id)` method that transactionally demotes the current primary of the group and marks the given row primary; idempotent when `id` is already primary; throws if `id` and current primary belong to different groups [beads:nx-0tmw]
- [ ] 3.5 Add `CredentialPool.deleteById(id, opts?: { promoteId?: string })` method: rejects if row is primary AND group has >1 member AND `promoteId` is absent; when `promoteId` is supplied, runs `promote(promoteId)` then deletes [beads:nx-b0v4]

## 4. Service — File Watcher Integration

- [ ] 4.1 When the file watcher detects a new credential file, call the fingerprint helper and insert via `CredentialPool.add()` so group assignment is automatic [beads:nx-504z]
- [ ] 4.2 When the file watcher detects a removed credential file and the removed row was `is_primary = true`, promote the newest remaining sibling (tiebreak: alphabetical `name`) before deletion; if the group becomes empty, no promotion is needed [beads:nx-nlm5]

## 5. API — Response Shape

- [ ] 5.1 `pool.list()` returns entries annotated with `fingerprint`, `duplicate_group_id`, `is_primary`; primary entries gain a `duplicates: [...]` array listing non-primary siblings in the same group [beads:nx-mhi4]
- [ ] 5.2 Confirm no `value_encrypted`, `access_token`, or refresh token material appears in the serialized response at any nesting level (extend existing test or add a new grep assertion) [beads:nx-3zw0]

## 6. API — DELETE Endpoint

- [ ] 6.1 Add `DELETE /credentials/{id}` handler in `apps/agent/src/routes/credentials.ts` that reads `?promote=` from the URL; returns 404 if id unknown [beads:nx-0g5k]
- [ ] 6.2 Handler returns 409 when the row is the primary of a multi-member group and no `promote` query param is supplied [beads:nx-idhw]
- [ ] 6.3 Handler invokes `pool.deleteById(id, { promoteId })` and emits a `credential.deleted` audit log entry with `actor`, `ip`, `detail.promoted_to` when applicable [beads:nx-ezmr]
- [ ] 6.4 Register the route in the agent HTTP router [beads:nx-1axc]

## 7. API — Promote Endpoint

- [ ] 7.1 Add `POST /credentials/{id}/promote` handler that invokes `pool.promote(id)`; returns 200 with the updated group membership on success, 404 for unknown id, 409 when id and current primary belong to different groups [beads:nx-tgxv]
- [ ] 7.2 Handler is idempotent (already-primary returns 200 with no state change) and emits a `credential.promoted` audit log entry [beads:nx-wcb7]
- [ ] 7.3 Register the route in the agent HTTP router [beads:nx-f8ne]

## 8. Tests

- [ ] 8.1 Unit test: `pool.add()` with a new fingerprint creates a fresh group and marks the row primary [beads:nx-ngh7]
- [ ] 8.2 Unit test: `pool.add()` with a duplicate fingerprint attaches as non-primary by default [beads:nx-kdhb]
- [ ] 8.3 Unit test: `pool.lease()` skips non-primary rows even when they have `rate_limit_count = 0` [beads:nx-ayfo]
- [ ] 8.4 Unit test: `pool.promote(id)` atomically swaps primary flag within a group and rejects cross-group promotion [beads:nx-0jl3]
- [ ] 8.5 Unit test: `pool.deleteById()` rejects primary-in-multi-member-group without promote, succeeds with promote [beads:nx-wnxb]
- [ ] 8.6 Integration test: migration backfill collapses three synthetic duplicates into one group with the newest row primary [beads:nx-yg2m]
- [ ] 8.7 Integration test: `GET /credentials` response includes `fingerprint`/`duplicate_group_id`/`is_primary` and nests `duplicates` on primaries [beads:nx-7vuw]
- [ ] 8.8 Integration test: `DELETE /credentials/{id}?promote=<sibling>` promotes the sibling and deletes the old primary in one request [beads:nx-ohn7]

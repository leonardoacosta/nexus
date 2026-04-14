# Proposal: Credential Identity & Duplicate Grouping

## Change ID
`credential-identity`

## Summary
Give every credential in the pool a stable identity key derived from its OAuth
refresh token, collapse duplicates into visible groups (never silently dedup),
and restrict lease selection to one primary member per group. Expose the
grouping in `GET /credentials` and add endpoints to delete or promote members of
a group.

## Why
The agent currently loads 18 credential files from `~/.config/nexus/credentials/`,
many of which are duplicate snapshots of the same Anthropic account captured at
different times (a 770 B stub vs a 2.9 KB copy with MCP state). Today every file
becomes its own pool entry with an arbitrary `acct-<8hex>` filename as the only
identity. As a result:

1. The same underlying account appears in the pool multiple times, skewing
   weighted round-robin lease selection toward whichever duplicate has the
   lowest `rate_limit_count`.
2. Users cannot tell from `GET /credentials` which rows refer to the same
   Anthropic account, so they cannot confidently delete stale snapshots.
3. When the active symlink points at a stale snapshot, usage polls and swaps
   operate on data that no longer matches the live Claude Code session.

The refresh token is stable across access-token refreshes and unique per
account, so hashing it gives a cheap, opaque fingerprint that both identifies
accounts and groups duplicates.

## What Changes

- **BREAKING (schema)** Add `fingerprint TEXT NOT NULL`, `duplicate_group_id
  TEXT NULL`, and `is_primary BOOLEAN NOT NULL DEFAULT false` columns to the
  `credentials` table, indexed on `fingerprint` and `(duplicate_group_id,
  is_primary)`.
- Backfill migration: compute a fingerprint for every existing row by
  decrypting and hashing its refresh token, assign `duplicate_group_id =
  fingerprint`, and mark the newest-`mtime` (tiebreak alphabetical) row in each
  group `is_primary = true`.
- `CredentialPool.lease()` restricts candidate selection to `is_primary = true`.
  Non-primary rows remain in the DB and appear in listings but are never leased.
- `GET /credentials` response: every entry gains `fingerprint`,
  `duplicate_group_id`, `is_primary` fields. Primary entries additionally gain
  a `duplicates: [{id, name, mtime, created_at, ...}]` array listing their
  non-primary siblings. `value_encrypted`, `access_token`, and refresh token
  material remain absent from the response.
- **NEW** `DELETE /credentials/{id}` — deletes a credential row. Rejects with
  `409 Conflict` if the row is `is_primary = true` AND its group has more than
  one member, unless `?promote=<other_id>` is supplied (in which case that
  sibling is promoted first, then the original primary is deleted). Emits an
  audit log entry.
- **NEW** `POST /credentials/{id}/promote` — promotes the given credential to
  primary within its duplicate group. Idempotent when the target is already
  primary. Returns 409 if the target is in a different group than the current
  primary.
- The file-system watcher that adds/removes credential files at runtime SHALL
  compute fingerprints for new files, attach them to the correct group, and
  promote a new primary if the removed file was the current primary.

## Impact

### Affected specs
- `credential-pool` (modified — lease selection, schema, file watcher)
- `credential-http-endpoint` (touched only for audit-trail parity; handled in a
  separate change if needed — this proposal confines API changes to the
  `credential-pool` capability since the two specs already share endpoint
  coverage)

### Affected code
- `packages/db/src/schema/credentials.ts` — new columns
- `packages/db/drizzle/*` — generated migration
- `apps/agent/src/credentials/pool.ts` — lease predicate, fingerprint lookup
- `apps/agent/src/credentials/store.ts` — query helpers for group membership
- `apps/agent/src/credentials/credentials.helpers.ts` — fingerprint computation
- `apps/agent/src/routes/credentials.ts` — response shape, new endpoints
- `apps/agent/src/credentials/*.test.ts` — unit coverage

### Affects (downstream specs)
- `session-token-stream` (separate proposal) will consume the new `fingerprint`
  column to correlate streaming sessions with a stable credential identity.
  Schedule `credential-identity` first.

## Out of Scope
- Cross-agent credential aggregation across machines.
- Symlink drift detection between `~/.claude/.credentials.json` and the pool.
- Any UI/dashboard changes — the dashboard will consume the extended
  `GET /credentials` shape unchanged.

## Risks

| Risk | Mitigation |
|------|-----------|
| Fingerprint computation fails for malformed files during migration | Row is retained with `fingerprint = "UNKNOWN-<id>"` and `is_primary = true`; WARN logged, operator visibility preserved |
| Every primary credential briefly unavailable during migration | Migration runs inside a single transaction; `is_primary` assignment is atomic per group |
| Lease selection filter regresses existing tests | New lease tests pin primary-only behavior before schema change lands |
| `DELETE` on the last primary of a multi-member group orphans duplicates | Endpoint rejects with 409 unless `?promote=<other_id>` is passed |

# Design: Credential Identity & Duplicate Grouping

## Context

`~/.config/nexus/credentials/` currently holds 18 `acct-*.json` files, many of
which are successive snapshots of the same Anthropic account captured at
different points in time (smaller stubs vs. larger copies that also carry MCP
state). Today the agent loads each file as a pool entry keyed by the arbitrary
`acct-<8hex>` filename. The filename is the only identity, so:

- The lease selector has no way to know that two rows refer to the same
  upstream account and will happily rotate between them.
- Operators cannot tell from `GET /credentials` which rows are duplicates, so
  stale snapshots accumulate indefinitely.
- The downstream `session-token-stream` spec needs a stable identity to
  correlate live Claude Code sessions with a credential row.

The OAuth payload inside each file contains `claudeAiOauth.refreshToken`, which
is stable across access-token refreshes and unique per account — the obvious
identity key. Hashing it yields an opaque, collision-resistant fingerprint.

Stakeholders: credential pool service, HTTP credential endpoints, file watcher,
future `session-token-stream` consumer.

## Goals / Non-Goals

### Goals
- Every credential row has a deterministic, non-PII identity derived from its
  OAuth material.
- Duplicates are visible in the API, not silently collapsed, so operators can
  delete stale snapshots with intent.
- Only one credential per duplicate group is leaseable at a time.
- Runtime file-watcher events keep groups consistent (new files join the right
  group; removing a primary promotes a sibling).

### Non-Goals
- Cross-machine credential reconciliation.
- Symlink drift detection between `~/.claude/.credentials.json` and the pool.
- Re-encryption or key rotation (the fingerprint is computed against plaintext
  refresh tokens that are already decrypted in-memory during load).
- Dashboard/UI changes.

## Decisions

### Decision 1: Fingerprint = SHA-256 of raw refresh token

The fingerprint column stores `sha256(refreshToken)` as lowercase hex (64
chars).

**Alternatives considered:**

- **HMAC-SHA-256 keyed by `NEXUS_ENCRYPTION_KEY`.** Rejected. HMAC would
  prevent an attacker with read-only DB access from confirming a guessed
  refresh token, but that threat is already dominated by the fact that the
  encrypted value is sitting right next to the fingerprint in the same table.
  Keyed hashes also mean rotating `NEXUS_ENCRYPTION_KEY` would invalidate every
  fingerprint, which complicates an already-complex rotation story.
- **Truncated hash (first 16 bytes).** Rejected. Saves 32 bytes per row for no
  meaningful benefit; collision resistance on full SHA-256 is effectively
  free.
- **UUIDv5 of the refresh token.** Rejected. Adds a dependency and produces an
  identical-in-spirit value to `sha256` with more ceremony.

Raw SHA-256 is simpler, still opaque (refresh tokens are uniformly random
high-entropy strings, so the hash leaks nothing the attacker didn't already
know), and trivial to recompute in any language or migration step.

### Decision 2: `duplicate_group_id` equals the fingerprint itself

The group ID is literally the fingerprint of the primary. No separate UUID is
generated.

**Alternatives considered:**

- **Separate UUID column.** Rejected. Two columns must be kept in sync during
  inserts, migrations, and promotions. Any bug that updates one but not the
  other silently orphans rows.
- **Group ID = min(id) within the group.** Rejected. Deleting the row whose
  id was chosen as the group ID would force a re-keying pass across all
  siblings.

Using the fingerprint directly gives a single source of truth: "rows with the
same fingerprint belong to the same group, full stop." The `duplicate_group_id`
column is kept as a nullable denormalization purely so SQL filters like
`WHERE duplicate_group_id = $1 AND is_primary = true` stay readable — it is
always equal to `fingerprint` in steady state.

### Decision 3: Primary selection on tie — alphabetical filename

When multiple rows share a fingerprint AND share the same `updated_at`/mtime
(common after a migration backfill that uses epoch-based stamps), the primary
is the one whose `name` sorts first lexicographically.

**Rationale:** Deterministic across re-runs of the migration, independent of
insertion order, and requires no additional columns. The usual case is that
mtimes differ — this only fires on exact ties.

### Decision 4: Orphan protection on DELETE — a 1-member group deletes freely

`DELETE /credentials/{id}` on a credential whose group has exactly one member
(the credential itself) is allowed unconditionally, same as deleting any
non-grouped credential would be today. The 409 protection only applies when
the row is primary AND the group has more than one member.

**Rationale:** A 1-member group is semantically identical to a non-grouped
credential — there is no sibling to orphan. Rejecting the delete would force
callers to promote a phantom sibling that does not exist.

### Decision 5: Migration safety — malformed rows become 1-member groups

If the backfill cannot compute a fingerprint for a row (decryption error,
unparseable OAuth JSON, missing `refreshToken`), the row is kept in the DB with:
- `fingerprint = 'UNKNOWN-' || id`
- `duplicate_group_id = 'UNKNOWN-' || id`
- `is_primary = true`

and a WARN log entry is emitted per degraded row.

**Rationale:** We must not drop credentials the operator deliberately added.
A degraded row remains leaseable (as a group of 1) and visible in `GET
/credentials`, so the operator can investigate or delete it manually. Using
`'UNKNOWN-' || id` as both fingerprint and group id guarantees no two degraded
rows collide into a fake group.

## Risks / Trade-offs

- **Lease regression.** Adding `is_primary = true` to the lease predicate is a
  silent behavior change for any non-grouped pool (no duplicates). Mitigation:
  backfill unconditionally marks every row primary, so single-member groups
  behave identically to today. Tests 8.1 and 8.3 pin the primary-only
  constraint.
- **Fingerprint churn if Anthropic ever rotates refresh tokens.** Anthropic's
  OAuth contract treats the refresh token as long-lived, but if they ever
  issue a new one on a rotation event, the fingerprint would change and the
  row would drift into its own group. Mitigation: the file watcher would
  observe a new file mtime and the `pool.add()` path handles re-grouping
  naturally.
- **409 on DELETE without `?promote=` may surprise scripts.** Documented in
  the spec and in the HTTP response body with the list of eligible siblings
  so the caller can retry with the promote query param.

## Migration Plan

1. Ship schema change + empty `fingerprint` column defaulted to a placeholder
   (migration step 1.3).
2. Backfill script (step 1.4) runs inside the same migration transaction:
   decrypt, hash, update rows, assign group IDs, mark primaries.
3. Drop the placeholder default at the end of the same migration so
   `fingerprint` becomes `NOT NULL` for subsequent inserts.
4. Deploy the code change that writes `fingerprint` at insert time (step 3.1).

Rollback: the migration is reversible by dropping the three columns. The
application code tolerates the rollback because `is_primary` and
`duplicate_group_id` are only read via the new query helpers; the lease path
falls back to its pre-change behavior if the column is absent. In practice we
will prefer forward-fixing rather than rollback.

## Open Questions

None remaining — all five design questions from the brief are resolved above.

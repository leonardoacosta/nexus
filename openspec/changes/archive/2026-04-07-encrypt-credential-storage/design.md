# Design: Encrypt Credential Storage

## Context

Credentials (API tokens, OAuth access tokens) are held in a central Postgres
table used by the Nexus agent. The table currently stores values in a
`value_plaintext text NOT NULL` column. All agents that share the datastore
role can read this column, and any DB backup or dump exposes every credential
in cleartext.

Additionally, the HTTP ingest path (`POST /credentials`) accepts values over
plain HTTP connections, and the Rust pool service writes a usage-cache JSON
file without filesystem permission restrictions.

## Goals / Non-Goals

- **Goals**
  - Encrypt credential values at rest (AES-256-GCM) using a server-managed key
  - Support key rotation via a `encryption_key_id` column without downtime
  - Provide a safe, idempotent migration path for existing plaintext rows
  - Harden the ingest endpoint with TLS enforcement
  - Fix reliability gaps: unhandled void promises, empty-key collision,
    usage-cache file permissions
  - Add weighted round-robin and predictive pre-rotation for better pool
    utilisation
  - Add a per-credential health-check endpoint for revocation detection

- **Non-Goals**
  - Client-side (end-to-end) encryption — server holds the key
  - Hardware Security Module (HSM) integration in this change
  - Multi-tenant key isolation (single key per deployment for now)
  - Changing the transport protocol from HTTP to gRPC

## Decisions

### Encryption algorithm: AES-256-GCM

**Decision:** AES-256-GCM with a random 96-bit nonce per encryption operation.

**Rationale:** AEAD construction provides both confidentiality and
integrity. The nonce is prepended to the ciphertext before base64 encoding
(`nonce || ciphertext`), making storage self-contained and rotation-safe. A
256-bit key from `NEXUS_ENCRYPTION_KEY` is used directly (hex or base64,
must be exactly 32 bytes after decode).

**Alternatives considered:**
- ChaCha20-Poly1305: equally valid, but AES-256-GCM is better supported by
  existing Node/Bun crypto APIs and hardware acceleration is available on most
  x86-64 targets.
- Envelope encryption (DEK/KEK): deferred — `encryption_key_id` column is
  added now to make this migration non-breaking when introduced later.

### Schema change: rename + add column

**Decision:**
- Rename `value_plaintext` → `value_encrypted` in the Drizzle schema and DB.
- Add `encryption_key_id text NOT NULL DEFAULT 'v1'` to record which key
  version encrypted the value.

**Migration steps (Drizzle migration):**
1. Add `value_encrypted text` (nullable) and `encryption_key_id text` columns.
2. Run the one-time `scripts/encrypt-credentials.ts` to populate
   `value_encrypted` for every row.
3. Alter `value_encrypted` to `NOT NULL`.
4. Drop `value_plaintext`.

The Drizzle ORM schema file is updated in one commit; the SQL migration is
generated via `drizzle-kit generate`.

### Migration script: idempotent, row-by-row

`scripts/encrypt-credentials.ts` selects rows where `value_encrypted IS NULL`,
reads `value_plaintext`, encrypts, writes `value_encrypted` and
`encryption_key_id`. It skips rows already encrypted, so re-running is safe.
The script requires `NEXUS_ENCRYPTION_KEY` and `POSTGRES_URL` in environment.

**Rollback:** If the migration must be reverted before the `value_plaintext`
column is dropped, decrypt all rows, clear `value_encrypted`, and revert the
code deploy. The column drop is a separate, irreversible step and MUST NOT be
applied until the new code is confirmed stable in production.

### TLS enforcement on credential ingest

**Decision:** `handleAddCredential` inspects `request.url` to detect scheme.
Requests arriving as `http://` from non-loopback addresses are rejected with
`426 Upgrade Required`. Loopback (`127.0.0.1`, `::1`) is exempt for local
integration tests.

The agent already sits behind Traefik with TLS termination, so in practice
all external traffic arrives over HTTPS. The check is a defence-in-depth guard
against misconfiguration.

### Weighted round-robin lease selection

**Decision:** Each credential carries a `rate_limit_count int NOT NULL DEFAULT 0`
counter in the `credentials` table (added in this migration). The lease
selection query orders available credentials by `rate_limit_count ASC, leased_at
ASC NULLS FIRST` — fewer rate-limit events = higher preference. The counter is
incremented atomically in `reportRateLimit`.

**Rationale:** Simple, cheap, uses existing transaction infrastructure.
Full exponential back-off weighting is deferred to a future change.

### Predictive pre-rotation at 85% utilization

**Decision:** During usage-poll processing, any credential whose 5-hour
utilization reaches ≥ 85% is immediately swapped out (its currently-leased
session is migrated to the next-best credential) before hitting the API limit.
The 85% threshold is configurable via `NEXUS_PREROTATE_THRESHOLD` (default
`0.85`).

**Rationale:** Prevents hard 429 interruptions for long-running sessions.
Trade-off: the 15% headroom is deliberately conservative — false positives
(unnecessary rotation) are preferable to service interruption.

### Per-credential health-check endpoint

**Decision:** `GET /credentials/{id}/health` calls the Anthropic API with the
stored credential to detect revocation. It returns `{ healthy: boolean,
checked_at: string }`. The check is on-demand (not polled) to avoid burning
quota.

### Usage-cache file permissions

**Decision:** The Rust `credential_pool.rs` writer applies `chmod(path, 0o600)`
after atomic rename. This matches the existing pattern used for pool credential
files on line 321 of the same file.

### derive_account_name validation

**Decision:** After stripping the `acct-` prefix and `.json` suffix, if the
resulting string is empty, `derive_account_name` returns `Err(anyhow!("empty
account name in file: {path}"))` rather than an empty string. The caller skips
the file with a `WARN` log entry.

### Cleanup timer: unhandled rejections

**Decision:** Replace `void this.recoverExpiredCooldowns()` /
`void this.cleanupStaleLeases()` in `startCleanup` with an async arrow that
catches and logs errors:

```ts
setInterval(async () => {
  await this.recoverExpiredCooldowns().catch(err =>
    logger.error({ err }, "cleanup: recoverExpiredCooldowns failed"));
  await this.cleanupStaleLeases().catch(err =>
    logger.error({ err }, "cleanup: cleanupStaleLeases failed"));
}, intervalMs);
```

### OTel/Sentry lifecycle events

**Decision:** Each of `lease`, `release`, `reportRateLimit`, `recoverExpiredCooldowns`,
and `cleanupStaleLeases` emits a `logger.info` structured event with a
canonical `event` field (e.g., `event: "credential.leased"`) in addition to
existing log calls. A follow-on change will wire these events to an OTel span
exporter. For now the structured log fields are the integration contract.

## Risks / Trade-offs

| Risk | Mitigation |
| ---- | ---------- |
| Operator forgets to run migration before deploy | Agent startup validates `value_encrypted` is populated; warns and falls back to read `value_plaintext` for a 1-week grace period, then hard-fails | 
| Key loss = permanent data loss | Document key backup procedure in runbook; recommend storing `NEXUS_ENCRYPTION_KEY` in a secrets manager |
| Performance overhead of AES-GCM per read | Negligible: credential reads are infrequent (lease events), not hot-path |
| Weighted round-robin counter drift after manual resets | Counter is observable via `GET /credentials` response; operator can reset via direct SQL during maintenance |

## Migration Plan

1. Deploy schema migration (`value_encrypted` nullable, `encryption_key_id`,
   `rate_limit_count` columns added; `value_plaintext` kept temporarily).
2. Run `scripts/encrypt-credentials.ts` on the datastore.
3. Verify row count matches and no `value_encrypted IS NULL` rows remain.
4. Deploy code that reads `value_encrypted` exclusively.
5. Run second migration: `ALTER TABLE credentials ALTER COLUMN value_encrypted SET NOT NULL; ALTER TABLE credentials DROP COLUMN value_plaintext;`.
6. Remove grace-period fallback code path.

**Rollback (before step 5):** Revert code deploy, all rows still have
`value_plaintext` intact. After step 5, rollback requires restoring a backup.

## Open Questions

- Should `NEXUS_ENCRYPTION_KEY` be a 32-byte hex string or accept base64 as
  well? (Current decision: accept both; validate at startup with clear error.)
- Threshold for pre-rotation (85%) — confirm with operators after initial
  deployment, expose as env var.

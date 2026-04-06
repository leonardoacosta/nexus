# Change: Encrypt credential storage and harden credential lifecycle

## Why

A platform audit on 2026-04-06 found that credential values are stored as
plaintext in the Postgres `credentials.value_plaintext` column. A single
database compromise exposes every token in the system. Two additional P1/P2
findings — no TLS enforcement on the credential ingestion endpoint and missing
sanitisation in the key-derivation path — compound the blast radius. The P3
findings surface several reliability gaps in the Bun credential pool that
increase operational risk.

## What Changes

- **BREAKING** — `credentials.value_plaintext` column renamed to
  `value_encrypted`; stored values are AES-256-GCM ciphertexts encoded in
  base64. Reads must decrypt; writes must encrypt. Applications without
  `NEXUS_ENCRYPTION_KEY` in their environment cannot start.
- **BREAKING** — `value_encrypted` field added to Drizzle schema; ORM type
  for the column changes from `value_plaintext: string` to
  `value_encrypted: string` with a companion `encryption_key_id: string`
  column to support future key rotation.
- A one-time migration script (`scripts/encrypt-credentials.ts`) reads each
  plaintext row, encrypts it, and updates in-place. The script is idempotent
  and safe to re-run.
- HTTP endpoint for `POST /credentials` MUST reject requests when the
  connection is not over HTTPS (enforced by checking `X-Forwarded-Proto` or
  `request.url` scheme for non-loopback callers).
- Usage-cache file (`~/.config/nexus/state/usage-cache.json`) gains `0o600`
  restricted permissions on write, consistent with pool credential files.
- `derive_account_name` in the Rust crate MUST validate that the derived
  name is non-empty; an empty result MUST be treated as a parse error, not
  silently inserted into pool state.
- Cleanup timer in `CredentialPool.startCleanup` MUST use `await`-based
  scheduling (or catch unhandled rejection) instead of bare `void` promises.
- Credential lifecycle events (lease, release, cooldown entry/exit) MUST emit
  structured log events consumable by an OTel/Sentry integration.
- Skipped test suites in `credentials.test.ts` MUST be implemented.
- **ADDED** — Weighted round-robin lease selection: credentials are ranked by
  historical rate-limit frequency; credentials with fewer historical
  rate-limits are preferred.
- **ADDED** — Predictive pre-rotation at 85% utilization: the pool
  proactively rotates before exhaustion rather than reacting to a 429.
- **ADDED** — Per-credential health-check endpoint (`GET
  /credentials/{id}/health`) for detecting revoked or invalid tokens.

## Impact

- Affected specs: `credential-pool`, `database-foundation`,
  `credential-http-endpoint`
- Affected code:
  - `packages/db/src/schema/credentials.ts` — schema column rename + new column
  - `apps/agent/src/credentials/pool.ts` — encryption/decryption, weighted
    round-robin, predictive pre-rotation, OTel events, cleanup timer fix
  - `apps/agent/src/routes/credentials.ts` — TLS enforcement, health endpoint
  - `apps/agent/src/credentials/credentials.test.ts` — enable skipped tests
  - `crates/nexus-agent/src/services/credential_pool.rs` — usage-cache chmod,
    `derive_account_name` validation
  - New: `scripts/encrypt-credentials.ts` — one-time migration
- Deployment: requires `NEXUS_ENCRYPTION_KEY` env var (32 random bytes, hex
  or base64-encoded). Operators MUST run the migration script before restarting
  the agent.

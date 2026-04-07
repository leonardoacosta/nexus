## 1. Schema & Migration (database-foundation)

- [x] 1.1 Add `value_encrypted text`, `encryption_key_id text NOT NULL DEFAULT 'v1'`, and `rate_limit_count int NOT NULL DEFAULT 0` columns to `packages/db/src/schema/credentials.ts`; keep `value_plaintext` temporarily
- [x] 1.2 Generate Drizzle migration: `npx drizzle-kit generate`
- [x] 1.3 Write `scripts/encrypt-credentials.ts` — selects rows where `value_encrypted IS NULL`, encrypts with AES-256-GCM, writes `value_encrypted` + `encryption_key_id`
- [x] 1.4 Write second migration SQL to set `value_encrypted NOT NULL` and drop `value_plaintext` (applied after encryption script confirms zero null rows)
- [x] 1.5 Update Drizzle schema to remove `value_plaintext` column (applied after step 1.4)

## 2. Encryption Library (shared)

- [x] 2.1 Implement `encrypt(plaintext: string, key: Buffer): string` using `node:crypto` AES-256-GCM — output format: `base64(nonce || ciphertext || authTag)`
- [x] 2.2 Implement `decrypt(ciphertext: string, key: Buffer): string` — inverse of 2.1
- [x] 2.3 Implement `loadEncryptionKey(): Buffer` — reads `NEXUS_ENCRYPTION_KEY` env var, accepts hex (64 chars) or base64 (44 chars), validates 32-byte length, throws on invalid/missing
- [x] 2.4 Call `loadEncryptionKey()` at agent startup; fail fast with clear error if key is absent or malformed

## 3. Credential Pool — Encryption (pool.ts)

- [x] 3.1 Update `CredentialPool.add()` to encrypt `value_plaintext` → store as `value_encrypted` using the key loaded in 2.3
- [x] 3.2 Update `CredentialPool.lease()` to decrypt `value_encrypted` before returning the credential row
- [x] 3.3 Update `CredentialPool.reportRateLimit()` to decrypt returned rows
- [x] 3.4 Remove `valuePlaintext` spread strips from `handleLeaseCredential` and `handleReportRateLimit` in `routes/credentials.ts`; the `list()` method already strips the encrypted value column

## 4. Credential Pool — Weighted Round-Robin

- [x] 4.1 Update `CredentialPool.lease()` SELECT to order by `rate_limit_count ASC, leased_at ASC NULLS FIRST` instead of unordered `LIMIT 1`
- [x] 4.2 Update `CredentialPool.reportRateLimit()` to increment `rate_limit_count` atomically on the cooled-down credential

## 5. Credential Pool — Predictive Pre-Rotation

- [x] 5.1 Add `NEXUS_PREROTATE_THRESHOLD` env var with default `0.85`; validate range (0.0–1.0) at startup
- [x] 5.2 After each usage poll, check 5h utilization for all leased credentials; if `utilization >= threshold`, call `reportRateLimit(id, leasedBy)` to proactively rotate

## 6. TLS Enforcement on Credential Ingest

- [x] 6.1 In `handleAddCredential`, extract scheme from `request.url`; if `http:` and remote host is not loopback, return `426 Upgrade Required` with `Upgrade: TLS/1.2, HTTPS` header
- [x] 6.2 Write unit test: non-loopback HTTP request is rejected with 426; loopback HTTP and HTTPS pass through

## 7. Health-Check Endpoint

- [x] 7.1 Implement `GET /credentials/{id}/health` — decrypts credential, calls Anthropic API with token (e.g., HEAD on `/api/oauth/usage`), returns `{ healthy: boolean, checked_at: string }`
- [x] 7.2 If credential not found, return 404; if decryption fails, return 500
- [x] 7.3 Wire route into agent HTTP router

## 8. OTel / Structured Lifecycle Events

- [x] 8.1 Add `event: "credential.leased"` structured field to `lease()` logger call
- [x] 8.2 Add `event: "credential.released"` structured field to `release()` logger call
- [x] 8.3 Add `event: "credential.cooldown_entered"` structured field to `reportRateLimit()` logger call
- [x] 8.4 Add `event: "credential.cooldown_exited"` structured field to `recoverExpiredCooldowns()` logger call
- [x] 8.5 Add `event: "credential.stale_lease_released"` structured field to `cleanupStaleLeases()` logger call
- [x] 8.6 Add `event: "credential.prerotation_triggered"` structured field when predictive rotation fires (step 5.2)

## 9. Cleanup Timer Fix

- [x] 9.1 Replace bare `void` calls in `startCleanup` with async arrow + `.catch(err => logger.error(...))` pattern for both `recoverExpiredCooldowns` and `cleanupStaleLeases`

## 10. Rust: Usage-Cache File Permissions

- [x] 10.1 In `crates/nexus-agent/src/services/credential_pool.rs`, apply `std::fs::set_permissions(path, Permissions::from_mode(0o600))` after writing `usage-cache.json`

## 11. Rust: derive_account_name Validation

- [x] 11.1 In `credential_pool.rs:derive_account_name`, return `Err` if the derived name string is empty after stripping prefix/suffix; update caller to log `WARN` and skip the file

## 12. Tests

- [x] 12.1 Enable all `.skip` stubs in `apps/agent/src/credentials/credentials.test.ts`; implement each skipped test
- [x] 12.2 Add test: `add()` stores encrypted value (decryptable with correct key, unreadable as plaintext)
- [x] 12.3 Add test: `lease()` returns decrypted value
- [x] 12.4 Add test: weighted round-robin prefers credential with lower `rate_limit_count`
- [x] 12.5 Add test: predictive pre-rotation fires when utilization ≥ 85%
- [x] 12.6 Add test: `GET /credentials/{id}/health` returns `{ healthy: true }` on valid token; `{ healthy: false }` on revoked token
- [x] 12.7 Add test: TLS enforcement rejects non-loopback HTTP
- [x] 12.8 Add test: cleanup timer logs errors instead of swallowing them
- [x] 12.9 Add test: `derive_account_name` returns error for `acct-.json` (already covered by Rust unit test in `credential_pool.rs:1039`)

## 13. Documentation & Runbook

- [x] 13.1 Add `NEXUS_ENCRYPTION_KEY` and `NEXUS_PREROTATE_THRESHOLD` to `.env.example`
- [x] 13.2 Document migration procedure in operator runbook (key generation, script execution, verification, column drop)
- [x] 13.3 Update `credential-pool` and `database-foundation` spec Purpose sections after archiving this change

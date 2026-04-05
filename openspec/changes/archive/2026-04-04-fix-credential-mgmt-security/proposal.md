# Proposal

## Change ID

fix-credential-mgmt-security

## Summary

Fix five latent security vulnerabilities in the credential management subsystem: token serialization leak, timing side-channel in secret validation, TOCTOU race in credential leasing, misleading plaintext field name, and credential file permission gaps.

## Context

The nexus credential management layer spans Rust (nexus-core, nexus-agent, nexus-status) and TypeScript (apps/agent, packages/db). An audit of these paths identified five distinct issues ranging from P2 (latent token leak, timing attack, data race) to P3 (plaintext field naming, missing 0600 permissions). All issues are addressable without architectural changes, except Req-4 which requires a DB schema migration.

## Motivation

- `CredentialAccount` derives `Serialize` without guarding `access_token`, so any code path that serializes the struct — logs, debug output, API responses — silently emits the raw bearer token.
- `validate_secret` uses `==` for secret comparison, creating a timing oracle attackable via network.
- `CredentialPool.lease()` executes a read-then-write without a transaction lock, allowing two concurrent callers to acquire the same credential.
- The DB column `value_encrypted` stores plaintext, misleading engineers and auditors into believing data is protected at rest.
- Credential JSON files are written without setting 0600 mode, leaving tokens world-readable on multi-user machines.

## Requirements

### Req-1: Token Type Safety

`CredentialAccount.access_token` MUST NOT appear in any serialized output by default. The Rust struct MUST annotate the field with `#[serde(skip)]` to suppress serialization entirely. Any API response type that legitimately needs to transmit credentials MUST use a dedicated response DTO with explicit field inclusion and MUST annotate sensitive fields with `#[serde(skip_serializing)]` when the field must be excluded from outbound responses.

#### Scenario: CredentialAccount serialized to JSON

- **WHEN** `serde_json::to_string(&account)` is called on any `CredentialAccount` instance
- **THEN** the resulting JSON MUST NOT contain an `access_token` key

#### Scenario: API response omits token

- **WHEN** the agent handles `GET /credentials`
- **THEN** the JSON response body contains no `access_token` key at any nesting level

### Req-2: Constant-Time Secret Comparison

The `validate_secret` function in `crates/nexus-agent/src/http_handlers/commands.rs` MUST use a constant-time equality check instead of the `==` operator. The comparison MUST use the `subtle` crate's `ConstantTimeEq` trait applied to byte slices derived from the expected and provided secret strings.

#### Scenario: Valid secret accepted in constant time

- **WHEN** a request includes the correct `x-nexus-secret` header value
- **THEN** the comparison completes without early exit and returns `Ok(())`

#### Scenario: Invalid secret rejected in constant time

- **WHEN** a request includes an incorrect `x-nexus-secret` header value
- **THEN** the comparison runs for the same wall-clock duration as a valid match and returns `Err((401, "unauthorized"))`

### Req-3: Atomic Credential Leasing

The `CredentialPool.lease()` method in `apps/agent/src/credentials/pool.ts` MUST wrap the read-then-update sequence in a single SQL transaction with a `SELECT ... FOR UPDATE` lock. No two concurrent callers MUST be able to acquire the same credential row.

#### Scenario: Two concurrent lease calls for same type

- **WHEN** two callers invoke `lease("api-key", ...)` simultaneously against a pool with one available credential
- **THEN** exactly one caller receives the credential and the other receives `null`

#### Scenario: Lease succeeds under normal load

- **WHEN** `lease` is called sequentially against a pool with available credentials
- **THEN** the credential is returned and its status is updated to `"leased"` atomically

### Req-4: Honest Field Naming

The `value_encrypted` column in `packages/db/src/schema/credentials.ts` and the underlying `credentials` table MUST be renamed to `value_plaintext` to accurately reflect that the stored value is not encrypted. A corresponding Drizzle migration MUST rename the column in the database. Actual AES-256-GCM encryption via the `ring` crate is deferred as a future growth concern (GCF).

#### Scenario: Schema reflects storage reality

- **WHEN** the schema is inspected
- **THEN** the column is named `value_plaintext` with no suggestion of encryption

#### Scenario: Migration applied to existing database

- **WHEN** the rename migration runs against an existing `credentials` table
- **THEN** the column is renamed without data loss and all existing rows remain accessible

### Req-5: Credential File Permissions

All writes to credential JSON files in `crates/nexus-agent/src/services/credential_pool.rs` MUST use `OpenOptions` with `OpenOptionsExt::mode(0o600)` so that the files are owner-read/write only. This applies to both the initial write at lines 804 and 853 and any subsequent update writes.

#### Scenario: Credential file created with restricted permissions

- **WHEN** the agent writes a new credential file to the pool directory
- **THEN** the resulting file has Unix permissions `0600` (owner rw, no group or other access)

#### Scenario: Credential file updated preserves restricted permissions

- **WHEN** an existing credential file in the pool is overwritten during token refresh
- **THEN** the updated file retains `0600` permissions

## Scope

**In scope:**
- `crates/nexus-core/src/credentials.rs` — `#[serde(skip)]` on `access_token`
- `crates/nexus-agent/src/http_handlers/commands.rs` — constant-time comparison
- `apps/agent/src/credentials/pool.ts` — transactional lease
- `packages/db/src/schema/credentials.ts` — column rename + migration
- `crates/nexus-status/src/main.rs` — token passed via curl `-H` arg (P3, see nx-sp07)
- `crates/nexus-agent/src/services/credential_pool.rs` — 0o600 file permissions
- Concurrent lease race condition test

**Out of scope:**
- AES-256-GCM encryption of stored credentials (GCF)
- Token rotation or expiry enforcement changes

## Impact

- **Affected specs:** `credential-pool`, `credential-http-endpoint`, `credential-management`
- **Affected code:** `crates/nexus-core/src/credentials.rs`, `crates/nexus-agent/src/http_handlers/commands.rs`, `apps/agent/src/credentials/pool.ts`, `packages/db/src/schema/credentials.ts`, `crates/nexus-agent/src/services/credential_pool.rs`, `crates/nexus-status/src/main.rs`
- **New dependencies:** `subtle` crate (Rust) for constant-time comparison

## Risks

- **Req-4 is a breaking DB schema change.** Renaming `value_encrypted` → `value_plaintext` requires a migration. Any code reading the old column name directly will break until updated. The migration must be applied before deploying the updated schema. Rollback requires a reverse migration.
- **Req-1 may break callers** that read `access_token` from a serialized `CredentialAccount` (e.g., test fixtures or CLI tooling). These must be updated to read the field directly from the Rust struct rather than from JSON.
- **Req-3 requires transaction support** in the Drizzle/pg layer; verify driver-level transaction support before implementation.

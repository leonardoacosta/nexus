## DB Batch

- [x] DB-1: Generate Drizzle migration to rename `value_encrypted` → `value_plaintext` in the `credentials` table (`packages/db/src/schema/credentials.ts` + `drizzle-kit generate`)
- [x] DB-2: Update all TypeScript references to `valueEncrypted` → `valuePlaintext` throughout `apps/agent/src/` and `packages/db/src/`
- [x] DB-3: Verify migration applies cleanly against a local Postgres instance and existing rows are preserved

## API Batch

- [x] API-1: Add `#[serde(skip)]` to `access_token` field in `CredentialAccount` (`crates/nexus-core/src/credentials.rs:12`)
- [x] API-2: Audit all call sites that access `CredentialAccount` fields after JSON deserialization and confirm `access_token` is populated via struct field, not JSON key
- [x] API-3: Add `subtle` crate dependency to `crates/nexus-agent/Cargo.toml`
- [x] API-4: Replace `==` with `subtle::ConstantTimeEq` byte-slice comparison in `validate_secret` (`crates/nexus-agent/src/http_handlers/commands.rs:113`)
- [x] API-5: Wrap `CredentialPool.lease()` read+update in a `db.transaction()` block with `SELECT ... FOR UPDATE` (`apps/agent/src/credentials/pool.ts:60-83`)
- [x] API-6: Replace `tokio::fs::write` calls at `credential_pool.rs:804` and `credential_pool.rs:853` with `OpenOptions`+`OpenOptionsExt::mode(0o600)` writes
- [x] API-7 (P3): Refactor `fetch_api_curl` in `crates/nexus-status/src/main.rs:371-386` to pass the Authorization header via stdin or a temp file rather than a CLI argument

## E2E Batch

- [ ] E2E-1: Add concurrent lease race test in `apps/agent/src/credentials/credentials.test.ts` — spawn two simultaneous `lease()` calls, assert exactly one succeeds and one returns `null` (covers nx-bpii)
- [ ] E2E-2: Run `cargo test -p nexus-core` and confirm `CredentialAccount` serialization test does not emit `access_token`
- [ ] E2E-3: Run `cargo test -p nexus-agent` and confirm `validate_secret` tests pass with constant-time path
- [ ] E2E-4: Run `pnpm typecheck` and `pnpm lint` in workspace root; confirm zero errors

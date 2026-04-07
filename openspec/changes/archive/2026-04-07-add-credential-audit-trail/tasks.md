## 1. Audit logger setup

- [x] 1.1 Create `auditLogger` child logger in `credentials.ts` via `createLogger("audit.credential")` from `@nexus/core`
- [x] 1.2 Define audit log schema: `{ event: string, credential_id: string, actor: string, ip: string, timestamp_iso: string, detail?: Record<string, unknown> }`

## 2. Lease audit trail

- [x] 2.1 Extract caller IP from `request` (check `x-forwarded-for` header, fall back to socket address)
- [x] 2.2 Emit `credential.leased` audit entry in `handleLeaseCredential` after successful pool.lease(), including `credential_id`, `actor` (leased_by), `ip`, `type`
- [x] 2.3 Add unit test: verify audit log is emitted on successful lease with expected fields

## 3. Rate-limit auto-swap audit trail

- [x] 3.1 Emit `credential.cooldown` audit entry in `handleReportRateLimit` for the cooled-down credential
- [x] 3.2 Emit `credential.auto_swap` audit entry when `result.next` is non-null, linking the cooled credential ID to the replacement credential ID
- [x] 3.3 Add unit test: verify both audit entries are emitted when auto-swap occurs
- [x] 3.4 Add unit test: verify only cooldown entry is emitted when no replacement is available

## 4. Health-check audit trail

- [x] 4.1 Accept `request: Request` parameter in `handleCredentialHealth` to extract caller IP
- [x] 4.2 Emit `credential.health_check` audit entry with `credential_id`, `ip`, `healthy` result, and `checked_at`
- [x] 4.3 Add unit test: verify audit log is emitted on health check

## 5. State directory permission hardening (Rust)

- [x] 5.1 In `notification_config.rs`, after `create_dir_all`, call `std::fs::set_permissions` with mode `0o700` on the state directory
- [x] 5.2 In `notification_mode.rs`, after `create_dir_all`, call `std::fs::set_permissions` with mode `0o700` on the state directory
- [x] 5.3 Add unit test: verify state directory is created with `0o700` permissions

## 6. Verification

- [x] 6.1 Run `cargo test` — all Rust tests pass
- [x] 6.2 Run `bun test` for credential test suites — all pass
- [x] 6.3 Manual smoke test: lease a credential and verify audit JSON line appears in stdout

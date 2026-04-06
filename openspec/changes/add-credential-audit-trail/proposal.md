# Change: Add credential access audit trail

## Why

A security review found that credential-access endpoints (lease, rate-limit
rotation, health check) decrypt and return or probe credential secrets without
emitting structured audit log entries. If a credential is compromised, there is
no forensic record of who retrieved it, when, or from which endpoint. A
secondary finding is that the Rust state directory
(`~/.config/nexus/state/`) is created with the process's default umask, which
on multi-user systems could expose usage-data filenames to other local users.

These gaps are distinct from the auth and encryption work tracked in
`secure-credential-routes` (REST auth, CORS, timing-safe comparison) and
`encrypt-credential-storage` (AES-256-GCM, key rotation, column rename).

## What Changes

- `handleLeaseCredential` emits a structured audit log entry on every
  successful lease, recording caller identity (`leased_by`), credential ID,
  credential type, and the caller's IP address / `x-forwarded-for` header.
- `handleReportRateLimit` emits a separate audit log entry when the auto-swap
  returns a replacement credential, linking the rate-limit event ID to the
  new credential lease.
- `handleCredentialHealth` emits an audit log entry recording who triggered
  the health check, the credential ID probed, and the health result.
- All audit entries use a dedicated `audit.credential` logger child with a
  consistent schema (`event`, `credential_id`, `actor`, `ip`,
  `timestamp_iso`, `detail`).
- Rust `create_dir_all` for `~/.config/nexus/state/` is followed by an
  explicit `set_permissions(0o700)` to restrict directory listing on
  multi-user systems.

## Impact

- Affected specs: `credential-http-endpoint`, `agent-security`
- Affected code:
  - `apps/agent/src/routes/credentials.ts` — audit log calls in lease,
    report-rate-limit, and health handlers
  - `apps/agent/src/credentials/pool.ts` — no changes (pool already logs
    lifecycle events; audit is at the HTTP layer)
  - `crates/nexus-agent/src/claude_utils/notification_config.rs` — state
    directory permission hardening
  - `crates/nexus-agent/src/claude_utils/notification_mode.rs` — state
    directory permission hardening

## 1. Next.js Sentry — Authorization Header Scrubbing

- [ ] 1.1 Add `beforeSend` hook to `apps/nextjs/sentry.server.config.ts` that strips `Authorization`, `x-nexus-secret`, and `Cookie` from `event.request.headers`
- [ ] 1.2 Add the same `beforeSend` hook to `apps/nextjs/sentry.client.config.ts` (if present)
- [ ] 1.3 Add the same `beforeSend` hook to `apps/nextjs/sentry.edge.config.ts` (if present)
- [ ] 1.4 Write a unit test asserting `beforeSend` returns an event with those headers removed

## 2. Rust Credential Import Breadcrumbs

- [ ] 2.1 Add `sentry::add_breadcrumb` call inside `bootstrap_import_credential` in `crates/nexus-agent/src/services/credential_pool.rs` with `category: "credential"`, `message: "credential imported"`, and fingerprint data
- [ ] 2.2 Add `sentry::add_breadcrumb` call inside `import_credential_to_pool` with `category: "credential"` and account name

## 3. Node.js Credential Lifecycle Observability

- [ ] 3.1 Wrap `CredentialPool.lease()` in `apps/agent/src/credentials/pool.ts` with an OTel span (`credential.lease`) carrying `{ type, leasedBy }` attributes
- [ ] 3.2 Add Sentry breadcrumb on successful lease: `category: "credential"`, `message: "credential leased"`
- [ ] 3.3 Wrap `CredentialPool.release()` with an OTel span (`credential.release`) carrying `{ id }` attribute
- [ ] 3.4 Add Sentry breadcrumb on successful release: `category: "credential"`, `message: "credential released"`
- [ ] 3.5 Wrap `CredentialPool.reportRateLimit()` with an OTel span (`credential.cooldown`) carrying `{ id, cooldown_until }` attributes
- [ ] 3.6 Add Sentry breadcrumb on cooldown: `category: "credential"`, `message: "credential on cooldown"`

## 4. Menubar Push Authentication

- [ ] 4.1 Read `NEXUS_INTERNAL_SECRET` env var in `push_to_menubars` in `crates/nexus-agent/src/services/credential_watcher.rs`
- [ ] 4.2 Add `x-nexus-secret: <secret>` header to all POST requests; if env var is absent, log a warning and skip the push (or reject with an error)
- [ ] 4.3 Document `NEXUS_INTERNAL_SECRET` in project env var reference

## 5. Cleanup Timer Error Handling

- [ ] 5.1 In `CredentialPool.startCleanup()` (`apps/agent/src/credentials/pool.ts`), replace `void this.recoverExpiredCooldowns()` with `this.recoverExpiredCooldowns().catch(err => logger.error(err, 'cleanup failed'))`
- [ ] 5.2 Replace `void this.cleanupStaleLeases()` with `.catch(err => logger.error(err, 'stale-lease cleanup failed'))`
- [ ] 5.3 Verify no other `void` promise patterns exist in the cleanup path

## 6. Pino Child Loggers in Health Modules

- [ ] 6.1 In `apps/agent/src/health-collector.ts`, replace the top-level `logger` usage with `logger.child({ component: 'health-collector' })`
- [ ] 6.2 In `apps/agent/src/health-scheduler.ts`, replace the top-level `logger` usage with `logger.child({ component: 'health-scheduler' })`

## 7. sessionsCache Test Isolation

- [ ] 7.1 In `apps/agent/src/routes/sessions.ts`, extract the cache state into a class or factory function so that tests can instantiate isolated instances
- [ ] 7.2 Update any existing tests that relied on `clearSessionsCache()` to use the new isolation mechanism
- [ ] 7.3 Verify no module-level mutable singleton remains accessible across test files

## 8. TUI Key Logging

- [ ] 8.1 In the TUI event loop (e.g., `crates/nexus-tui/src/app.rs`), add `tracing::trace!(key = ?event, "key pressed")` for every crossterm key event received
- [ ] 8.2 Confirm that `RUST_LOG=nexus_tui=trace` enables the output without impacting normal `info`-level usage

## 9. TUI Data Freshness Indicator

- [ ] 9.1 Track last-fetch timestamp in TUI app state (e.g., `last_refreshed: Option<Instant>`)
- [ ] 9.2 Render a human-readable "Updated Xs ago" label in the TUI status bar
- [ ] 9.3 Update the timestamp on every successful data refresh from the agent API

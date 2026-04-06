# Tasks: align-session-status

## 1. Rust — nexus-core enum and serialization

- [x] 1.1 Add `Ended` variant to `SessionStatus` in `crates/nexus-core/src/session.rs` (keep `#[serde(rename_all = "snake_case")]`)
- [x] 1.2 Implement `std::fmt::Display` for `SessionType` producing `"ad_hoc"`, `"managed"`, `"pooled"`
- [x] 1.3 Fix all non-exhaustive match arms on `SessionStatus` throughout the workspace (compiler-guided)
- [x] 1.4 Add `ENDED` variant to proto `SessionStatus` enum in `proto/nexus.proto`
- [x] 1.5 Update `From<SessionStatus>` / `From<proto::SessionStatus>` conversions in `nexus-core` to cover `Ended ↔ ENDED`
- [x] 1.6 Run `cargo build` — must compile with zero warnings on `SessionStatus` matches

## 2. Rust — registry serialization fix

- [x] 2.1 Replace `format!("{:?}", session.session_type).to_lowercase()` at `registry.rs:504` with `session.session_type.to_string()`
- [x] 2.2 Replace `format!("{:?}", session.status).to_lowercase()` at `registry.rs:255` and `registry.rs:502` with `session.status.to_string()` (add `Display` impl to `SessionStatus` similarly or rely on serde snake_case)
- [x] 2.3 Add `"ended"` arm to `session_from_record` status match in `registry.rs:526-532`
- [ ] 2.4 Verify roundtrip: write an `Ended` session to SQLite and read it back; status must equal `SessionStatus::Ended`

## 3. Rust — dedup guard fix

- [x] 3.1 Replace the blacklist dedup guard at `grpc/sessions.rs:114` with whitelist form:
      `.find(|s| s.cwd == cwd && matches!(s.status, SessionStatus::Active | SessionStatus::Idle))`
- [ ] 3.2 Add unit test: stale session at `/tmp/foo` → starting new session at `/tmp/foo` succeeds
- [ ] 3.3 Add unit test: errored session at `/tmp/bar` → starting new session at `/tmp/bar` succeeds

## 4. Rust — SIGKILL death confirmation

- [x] 4.1 Extract `wait_for_death(pid: u32, timeout_ms: u64) -> bool` helper in `grpc/sessions.rs`
- [x] 4.2 On Linux: poll `/proc/{pid}` existence at 50ms intervals up to `timeout_ms` (default 2000ms)
- [x] 4.3 On non-Linux: fall back to a fixed `tokio::time::sleep(Duration::from_millis(500))`
- [x] 4.4 Call `wait_for_death` after SIGKILL before `self.registry.remove()`
- [x] 4.5 Log a warning if death confirmation times out

## 5. Rust — detect_stale includes managed sessions

- [x] 5.1 Remove the `if session.tmux_session.is_some() { continue; }` early-exit guard in `registry.rs:426-428`
- [ ] 5.2 Verify existing stale detection tests still pass after removing guard
- [ ] 5.3 Add test: managed session (tmux_session Some) with heartbeat > stale threshold is marked stale

## 6. DB schema — Drizzle migration

- [x] 6.1 Check existing migrations in `packages/db/drizzle/` for numbering
- [x] 6.2 Create new Drizzle migration adding 13 columns to `sessions` table (see design.md §2)
- [x] 6.3 Update `packages/db/src/schema/sessions.ts` to include all new columns with correct types and nullable
- [ ] 6.4 Run `pnpm db:push` (or `pnpm drizzle-kit migrate`) against test DB to confirm migration applies cleanly
- [ ] 6.5 Verify existing rows receive NULLs for new columns (no data loss)

## 7. TS agent — error handling

- [x] 7.1 Wrap `getCachedSessions(db)` call in `handleGetSessions` with try/catch; return 500 JSON on error
- [x] 7.2 Wrap `getSessionById(db, id)` call in `handleGetSessionById` with try/catch; return 500 JSON on error
- [x] 7.3 Error response shape: `{ "error": "internal error", "detail": "<message if not production>" }`

## 8. TS agent — cache test isolation

- [ ] 8.1 Refactor `sessionsCache` from module-level singleton to factory pattern via `createSessionHandlers(db)`
  OR ensure `clearSessionsCache()` is called in test `beforeEach`
- [ ] 8.2 Update any existing code that uses the route handlers to work with the new structure

## 9. TS agent — integration tests

- [ ] 9.1 Replace all stub `expect(true).toBe(true)` bodies in `routes/sessions.test.ts` with real assertions
- [ ] 9.2 Test `handleGetSessions` returns array of sessions from seeded DB
- [ ] 9.3 Test `handleGetSessions` returns empty array when no sessions exist
- [ ] 9.4 Test `handleGetSessions?project=<name>` filters correctly
- [ ] 9.5 Test `handleGetSessions?project=<nonexistent>` returns empty array
- [ ] 9.6 Test `handleGetSessions?status=active` filters by status
- [ ] 9.7 Test combined project + status filter
- [ ] 9.8 Test `handleGetSessionById` returns session for known ID
- [ ] 9.9 Test `handleGetSessionById` returns 404 for unknown ID
- [ ] 9.10 Test `handleGetSessions?status=invalid` returns 400
- [ ] 9.11 Add seed helper and teardown in `beforeAll`/`afterAll`

## 10. TS agent — session-manager stale/errored

- [ ] 10.1 Add stale transition to `sweepIdle` in `session-manager.ts`: sessions idle > `staleThresholdMs` (default 300_000) become `stale`
- [ ] 10.2 On Linux: add errored transition for sessions whose `/proc/{pid}` no longer exists
- [ ] 10.3 Add unit tests for stale and errored transitions in session-manager

## 11. Next.js UI — null guard and duration fix

- [ ] 11.1 Fix `session.agent` null guard in `apps/nextjs/src/app/session/[id]/page.tsx:113`:
      change `<Badge>{session.agent}</Badge>` to `<Badge>{session.agent ?? "unknown"}</Badge>`
- [ ] 11.2 Fix duration calculation for ended sessions at `page.tsx:25-27`:
      use `session.endedAt` timestamp when available, fallback to `Date.now()`

## 12. Next.js — parallel agent fetch

- [ ] 12.1 Replace sequential `for` loop in `apps/nextjs/src/app/actions/session-detail.ts:24-31`
      with `Promise.all` across all agents
- [ ] 12.2 Return first non-null result; log agent name on match for observability

## 13. Verification

- [ ] 13.1 `cargo build --workspace` — zero errors and zero new warnings
- [ ] 13.2 `cargo clippy --workspace` — no new lints
- [ ] 13.3 `cargo test --workspace` — all tests pass
- [ ] 13.4 `bun test apps/agent/src/routes/sessions.test.ts` — all integration tests pass with `POSTGRES_URL` set
- [ ] 13.5 `pnpm typecheck` in `apps/nextjs` — zero type errors
- [ ] 13.6 Manual smoke test: start a session, verify `session_type` in DB is `"ad_hoc"` not `"adhoc"`
- [ ] 13.7 Manual smoke test: end a session, verify `status = "ended"` in DB and `SessionStatus::Ended` in Rust

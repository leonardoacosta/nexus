## Batch 1: API — Rust gRPC Fixes

- [ ] 1.1 **Req-1** (nx-q75y): In `handle_start_session`, move `register_managed` to after the `tokio::process::Command` spawn succeeds. On `Err(e)` from `.output().await`, call `self.registry.remove(&session_id).await` then return `Status::internal`.
- [ ] 1.2 **Req-2** (nx-8oib): Before `register_managed`, query the registry for any session with matching `cwd` and non-ended status. If found, return its `session_id` in `StartSessionResponse` without spawning.
- [ ] 1.3 **Req-4** (nx-4fci): In `handle_register_session`, add upfront guards: reject `pid == 0`, empty `cwd`, empty `session_id` with `Status::invalid_argument`.
- [ ] 1.4 **Req-5** (nx-zan1): Add `#[tracing::instrument(name = "session.get_all", skip(self, request))]` to `handle_get_sessions`.
- [ ] 1.5 **Req-5** (nx-zan1): Add `#[tracing::instrument(name = "session.get", skip(self, request), fields(session_id))]` to `handle_get_session`; record `session_id` on the span.
- [ ] 1.6 **Req-5** (nx-zan1): Add `#[tracing::instrument(name = "session.register", skip(self, request))]` to `handle_register_session`.
- [ ] 1.7 **Req-5** (nx-zan1): Add `#[tracing::instrument(name = "session.unregister", skip(self, request))]` to `handle_unregister_session`.
- [ ] 1.8 **Req-5** (nx-zan1): Add `#[tracing::instrument(name = "session.heartbeat", skip(self, request))]` to `handle_heartbeat`.
- [ ] 1.9 **Req-1 + Req-2**: Run `cargo clippy -p nexus-agent` and resolve any warnings introduced by the changes.
- [ ] 1.10 **Req-1 + Req-2**: Run `cargo test -p nexus-agent` to confirm no regressions.

## Batch 2: API — TypeScript Route Fixes

- [ ] 2.1 **Req-3** (nx-0554): In `apps/agent/src/routes/sessions.ts`, add `"stale"` and `"errored"` to `VALID_STATUSES`. Update the 400 error message to list all five values.
- [ ] 2.2 **Req-6** (nx-7f05): In `apps/agent/src/session-manager.ts`, add `endedSessionTtlMs` option to `createSessionManager()` (default `3_600_000`). In `sweepIdle`, after the idle-marking loop, iterate sessions where `status === "ended"` and `endedAt` is older than TTL; delete from Map.
- [ ] 2.3 **Req-6**: Export the options interface so callers can type-check TTL configuration.
- [ ] 2.4 **nx-jl1z**: In `apps/agent/src/routes/sessions.test.ts`, replace all `describe.skip` blocks with real integration tests against a test PG database (use `POSTGRES_URL` env var; skip automatically if not set via `describe.skipIf(!process.env.POSTGRES_URL, ...)`).
- [ ] 2.5 **nx-xlxx**: In `apps/agent/src/session-manager.test.ts`, add tests covering: `active → idle` transition, `idle → active` reactivation on heartbeat, `ended` status set on `session_end` event, eviction of ended sessions after TTL in `sweepIdle`.
- [ ] 2.6 Run `pnpm typecheck` in `apps/agent` and fix any type errors.
- [ ] 2.7 Run `pnpm test` in `apps/agent` and confirm all non-PG tests pass.

## Batch 3: UI — Next.js Error Boundaries

- [ ] 3.1 **Req-7** (nx-ia5f): Create `apps/nextjs/src/app/session/[id]/loading.tsx` — export a default `SessionDetailLoading` component that renders a skeleton layout matching the two-column structure of `page.tsx` (terminal placeholder on the left, metadata sidebar skeleton on the right).
- [ ] 3.2 **Req-7** (nx-ia5f): Create `apps/nextjs/src/app/session/[id]/error.tsx` — add `"use client"` directive; export a default `SessionDetailError` component accepting `{ error: Error; reset: () => void }` props; render an error card with the error message and a "Try again" button that calls `reset()`.
- [ ] 3.3 **Req-7**: In `apps/nextjs/src/app/session/[id]/page.tsx`, extract the main content render into a child async Server Component (`SessionDetailContent`) and wrap it in `<Suspense fallback={<SessionDetailLoading />}>`.
- [ ] 3.4 Run `pnpm typecheck` in `apps/nextjs` and fix any type errors.
- [ ] 3.5 Run `pnpm build` in `apps/nextjs` to confirm no build regressions.

## Batch 4: E2E — Un-skip Tests

- [ ] 4.1 Verify the test PG setup documentation in `apps/agent/src/routes/sessions.test.ts` is accurate (connection string, table creation command).
- [ ] 4.2 Add a `docker-compose.test.yml` or document the `testcontainers` approach for CI so the un-skipped tests run in CI without manual setup.
- [ ] 4.3 Run `pnpm test --filter=agent` with a live PG to confirm all integration tests pass.
- [ ] 4.4 Update `.beads/` — close nx-q75y, nx-8oib, nx-0554, nx-spkw, nx-4fci, nx-zan1, nx-jl1z, nx-7f05, nx-ia5f, nx-xlxx.

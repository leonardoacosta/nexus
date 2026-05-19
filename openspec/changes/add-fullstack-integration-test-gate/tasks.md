# Tasks: add-fullstack-integration-test-gate

<!-- beads:epic:nx-sk3dc -->
<!-- beads:feature:nx-9m0re -->

## API Batch

- [x] 1.1 `deploy/hooks.d/pre-push/01-deploy` — add an integration-gate stage
  BEFORE the build step: run the headless Tier A suite (`turbo test` for agent
  + Swift unit bundles via `xcodebuild test`), abort the push on any failure
  (reuse the hook's existing fail() contract). Add a macOS/GUI guard
  (`uname -s = Darwin` AND a usable-GUI probe, not SSH-only) that conditionally
  appends the Tier B stage; on non-macOS/headless emit an explicit `SKIP
  Tier B` marker line and do NOT fail the push for the skip. [beads:nx-gatgb]
- [x] 1.2 Un-stub agent integration tests — replace placeholder bodies in
  `apps/agent/src/routes/sessions.test.ts`, `apps/agent/src/routes/health-history.test.ts`,
  and `apps/agent/src/db/db.test.ts` with real assertions against live PG.
  The session test MUST assert a known PID → process-watcher → `/sessions`
  returns it with `lastActivity` within the freshness window (nx-z66n8
  regression surface). Resolves nx-qsj1, nx-it4u, nx-3awz. [beads:nx-k3uwu]
- [x] 1.3 Homelab-local transport check (runs on the agent host, loopback
  only): assert the agent binds the configured non-loopback interface (fails
  if loopback-only), `/sessions` and `/health` match the `packages/core`
  contract shape, and a `nexus-emit` socket event is observed at the
  dispatcher (spine round-trip). [beads:nx-8aj88]
- [x] 1.4 New reusable stub-agent harness `apps/agent/src/testing/stub-agent.ts`
  serving deterministic `/sessions`·`/health`·`/events` fixtures. It MUST bind
  a non-loopback address and MUST fail fast if pointed at
  `127.0.0.1`/`localhost`/`::1`/`*.local`. Fixtures are snapshotted from the
  real agent's responses and type-checked against `packages/core` schemas to
  prevent mock drift. [beads:nx-sdq5e]
- [x] 1.5 Bundle-integrity check: build the app via `xcodebuild` (NOT
  install.sh), then assert the produced bundle `Info.plist` contains
  `NSAppTransportSecurity` and `LSUIElement`, and the product is `nexus.app`.
  Guards the nx-5ws74 silent-no-op + ATS-config regression classes. [beads:nx-xin4t]

## UI Batch

- [ ] 2.1 Extend `apps/swift/NexusSharedTests/SessionDecodingTests.swift` to
  decode the full current `/sessions` wire shape AND the multi-agent
  aggregate envelope (payload-drift guard); fixtures shared with task 1.4. [beads:nx-3ltm0]
- [ ] 2.2 New XCUITest in the `nexus-mac-UITests` target: launch the built
  app, open the dashboard window, iterate every `DashboardSection` case and
  assert each detail view renders; assert the Sessions section triggers a
  session fetch (catches the SessionsView-never-mounts class, fault #4). Wire
  the target/path in `apps/swift/project.yml` if needed. [beads:nx-u17ua]
- [ ] 2.3 XCUITest commands-available check: assert the menu-bar surface and
  key commands (attach, Cmd+D open-dashboard) are reachable from the built app. [beads:nx-ri6go]
- [ ] 2.4 Client transport round-trip XCUITest: drive the built `.app` against
  the task-1.4 non-loopback stub; assert the fetch completes with no ATS
  `-1022`, the payload decodes, and the dashboard renders the fixture sessions
  deterministically (catches ATS fault #5-runtime + transport). [beads:nx-9kuwm]

## E2E Batch

- [ ] 3.1 Non-gating cross-host smoke: a real macbook→homelab Tailscale
  `/sessions` round-trip wired into the pre-push hook as report-only — its
  failure is logged but MUST NOT abort the push or fail the gating suite. [beads:nx-qm3be]
- [ ] 3.2 Gate self-validation: prove the pre-push hook (a) aborts the push
  when a Tier A test is seeded to fail, and (b) emits `SKIP Tier B` without
  failing when invoked with a forced-headless/non-GUI environment. Automate
  via a temporary failing fixture + a forced-headless env var; revert after. [beads:nx-eneff]

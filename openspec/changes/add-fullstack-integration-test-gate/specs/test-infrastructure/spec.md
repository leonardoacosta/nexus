## ADDED Requirements

### Requirement: Pre-push integration gate with macOS-guarded UI tier

The pre-push deploy hook MUST execute a headless integration tier (agent
contract + payload + bundle-integrity) before build, and MUST abort the push
when any non-skipped test fails. A second tier (XCUITest render checks and the
built-bundle transport round-trip) MUST run only when the host is `Darwin`
with a usable GUI session, and MUST emit an explicit SKIP marker (not a
failure) on headless or non-macOS hosts.

#### Scenario: headless host runs Tier A and skips Tier B

- **GIVEN** the pre-push hook runs on a non-macOS or GUI-less host
- **WHEN** the integration gate executes
- **THEN** the agent contract + payload + bundle-integrity tests run
- **AND** the XCUITest / built-bundle transport tests are reported as SKIP
- **AND** the push is not aborted solely because Tier B was skipped

#### Scenario: failing Tier A test aborts the push

- **GIVEN** a Tier A integration test fails
- **WHEN** the pre-push hook runs
- **THEN** the hook aborts the push with a non-zero status and a clear message

#### Scenario: macOS host runs Tier B

- **GIVEN** the pre-push hook runs on macOS with a GUI session
- **WHEN** the integration gate executes
- **THEN** the XCUITest render checks and built-bundle transport round-trip run
- **AND** a failure in either aborts the push

### Requirement: Client transport tier reproduces macOS ATS faithfully

The client transport test MUST drive the real built `.app` bundle against a
stub agent bound to a non-loopback address. A stub on `127.0.0.1`, `localhost`,
`::1`, or a `*.local` host is non-conforming because macOS exempts loopback and
link-local from App Transport Security, which would mask the cleartext
rejection class this test exists to catch.

#### Scenario: bundle transport round-trip against non-loopback stub

- **GIVEN** a stub agent serving deterministic fixtures on a non-loopback address
- **WHEN** the built `.app` bundle fetches sessions from it
- **THEN** the request completes without an ATS cleartext error
- **AND** the payload decodes and the dashboard renders the fixture sessions

#### Scenario: loopback stub is rejected as non-conforming

- **WHEN** the client transport test is configured against a `localhost`/`127.0.0.1` stub
- **THEN** the test setup fails fast with a non-conforming-address error

### Requirement: Dashboard render coverage for every navigation section

An XCUITest MUST launch the built app, open the dashboard window, and assert
that every `DashboardSection` case renders its detail view, so a
section/observer that never mounts is caught automatically.

#### Scenario: all sections render

- **GIVEN** the built app is launched and the dashboard window opened
- **WHEN** the test iterates every `DashboardSection`
- **THEN** each section's detail view is present
- **AND** the Sessions section triggers a session fetch

### Requirement: Homelab transport check runs locally on the agent host

The homelab transport check MUST run on the agent host against loopback
(no Tailscale dependency) and assert the agent binds the configured
non-loopback interface, serves the `/sessions` and `/health` contract shape,
and round-trips the UNIX socket spine.

#### Scenario: agent serves contract and spine locally

- **GIVEN** the agent is running on the homelab host
- **WHEN** the local transport check queries `/sessions`, `/health`, and emits a socket event
- **THEN** the responses match the `packages/core` contract shape
- **AND** the socket event is observed at the dispatcher

### Requirement: Real cross-host smoke is non-gating

A real macbook→homelab Tailscale round-trip MUST be reported but MUST NOT
abort a push or fail the gating suite.

#### Scenario: cross-host smoke fails without blocking

- **GIVEN** homelab is unreachable over Tailscale
- **WHEN** the non-gating smoke runs in the pre-push hook
- **THEN** its failure is reported
- **AND** the push is not aborted on that basis

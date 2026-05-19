# Proposal: Full-stack integration test gate (homelab + client transport)

## Change ID

add-fullstack-integration-test-gate

## Phase

Quality hardening — close the test-execution + client↔agent transport gap.

## Summary

The dashboard-empty incident was a five-layer silent-failure stack (agent
heartbeat, stale build, install.sh no-op, `SessionsView` never mounting, ATS
`-1022`). None was caught automatically because **no automation runs any
tests** (no CI; the deploy hooks build+install but gate on nothing) and there
is **no coverage of the client↔agent transport seam** where four of the five
faults lived. This change adds a full-stack integration test suite, gated in
the existing pre-push deploy hook, covering both the homelab agent and the
macOS client including the real built-bundle transport path.

## Context

- touches: `deploy/hooks.d/pre-push/01-deploy`, `apps/agent/src/routes/sessions.test.ts`, `apps/agent/src/routes/health-history.test.ts`, `apps/agent/src/db/db.test.ts`, `apps/agent/src/testing/stub-agent.ts`, `apps/swift/NexusSharedTests/SessionDecodingTests.swift`, `apps/swift/project.yml`
- Resolves stub debt: nx-qsj1, nx-it4u, nx-3awz
- Guards (does not depend on) fault classes: nx-5ws74 (install.sh no-op), nx-p2zs5 (ATS), nx-t9wrj (mount), nx-z66n8 (heartbeat)

## Motivation

The costliest property of the incident was not missing an end-to-end test —
it was **ambiguous signal** plus tests that exist but never run. Locked
decisions for this change:

- **Scope = full suite**: headless Tier A (agent contract + payload +
  bundle-integrity + un-stub) AND Tier B (XCUITest render-all-pages +
  commands + client transport round-trip).
- **Runner = pre-push hook on the build machine**, with a macOS/GUI guard:
  Tier A always runs and aborts the push on failure (consistent with the
  hook's existing "abort push on build failure" contract); Tier B
  (XCUITest + bundle transport) runs only when on macOS with a usable GUI
  session, otherwise logs an explicit SKIP (not a failure).
- **Transport = split the seam** (not a single flaky e2e):
  1. Client transport gate uses a local stub agent bound to a **non-loopback
     address** (NOT `127.0.0.1`/`localhost`/`*.local` — macOS exempts loopback
     from ATS, which would false-green the `-1022` fault) + the real built
     `.app`, with deterministic fixtures.
  2. Homelab transport check runs **on the homelab box, localhost-to-itself**
     (deterministic, no Tailscale flakiness): agent binds the configured
     non-loopback interface, serves the contract shape, socket spine
     round-trips.
  3. One real macbook→homelab Tailscale smoke as a **non-gating** fleet
     canary — reported, never blocks a push.

## Requirements

### Requirement: Pre-push hook gates on the integration suite

The pre-push deploy hook MUST run the headless integration tier before build
and MUST abort the push if any non-skipped test fails. The XCUITest /
built-bundle transport tier MUST run only when the host is macOS with a usable
GUI session and MUST log an explicit SKIP (not a failure) otherwise.

### Requirement: Client transport tier reproduces ATS faithfully

The client transport test MUST exercise the real built `.app` bundle against a
stub agent bound to a non-loopback address so the macOS ATS cleartext policy
is faithfully reproduced; a loopback/`*.local` stub is non-conforming.

### Requirement: Homelab transport check runs locally on the agent host

The homelab transport check MUST run on the agent host against its own
loopback (deterministic, no Tailscale dependency) and MUST assert the agent
binds the configured non-loopback interface, serves the `/sessions` and
`/health` contract shape, and round-trips the UNIX socket spine.

### Requirement: Real cross-host smoke is non-gating

The real macbook→homelab Tailscale round-trip MUST be reported but MUST NOT
block a push or fail the gating suite.

# test-infrastructure

## ADDED Requirements

### Requirement: Tier A Gate Retries a Flaky Failure Once

The pre-push Tier A turbo-test step MUST retry the suite once on failure before aborting the push,
so a single load-induced flake does not require a manual re-push, while a genuine regression
(failing both attempts) still blocks the push.

#### Scenario: Flaky-once failure proceeds on retry

- **WHEN** the Tier A `pnpm test` fails on its first attempt but passes on an immediate re-run
- **THEN** the hook proceeds with the push (does NOT abort) and records the first-attempt
  failure in a flake log

#### Scenario: Genuine failure still aborts

- **WHEN** the Tier A `pnpm test` fails on BOTH the first attempt and the retry
- **THEN** the hook aborts the push with a non-zero exit (the gate still blocks real regressions)

### Requirement: Gate Captures the Flaky Test Identity

The gate MUST record which test failed on a first-attempt-only flake, so the specific offender can
be fixed with evidence rather than guessed.

#### Scenario: Flake log records the offending test

- **WHEN** the Tier A suite fails on the first attempt and passes on retry
- **THEN** the failing test name(s) and a timestamp are appended to a persistent flake log for
  later targeted hardening

### Requirement: Timing-Sensitive Agent Tests Wait for Readiness, Not Fixed Budgets

Heavy/flake-prone agent tests that exercise real I/O (network, socket, Postgres, docker) MUST wait
for a condition with a generous deadline rather than racing a fixed `sleep`, and MUST gate the
real-I/O legs behind a capability/reachability probe.

#### Scenario: Poll-until-ready replaces fixed sleep

- **WHEN** a hardened test waits for a server/socket/row to become ready
- **THEN** it polls the condition up to a generous deadline (and gates on reachability/hasPg/
  hasDocker), instead of a single fixed `Bun.sleep` that can miss its budget under load

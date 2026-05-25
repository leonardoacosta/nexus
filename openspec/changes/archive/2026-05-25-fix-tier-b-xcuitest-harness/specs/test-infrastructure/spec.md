# test-infrastructure

## ADDED Requirements

### Requirement: Tier B Harness Cleanup Is nounset-Safe

The Tier B XCUITest harness (`deploy/run-tier-b-xcuitests.sh`) SHALL run its `cleanup()` trap
without error under `set -u` on bash 3.2, including when `TEST_LOGS` (or any tracked array) is
empty because the script exited before the array was populated.

#### Scenario: Cleanup runs with an empty TEST_LOGS array

- **WHEN** the harness exits before `TEST_LOGS` is populated (e.g. a `build-for-testing` failure
  or a stub failure aborts under `set -e`)
- **THEN** the `cleanup()` trap completes without emitting an `unbound variable` error, under
  bash 3.2 with `set -euo pipefail`

#### Scenario: No unguarded array expansion remains

- **WHEN** the harness is audited for array expansions under `set -u`
- **THEN** every array expansion uses a nounset-safe form (e.g. `"${arr[@]+"${arr[@]}"}"`) so a
  future empty-array path cannot reintroduce the crash

### Requirement: Tier B Harness Surfaces the Real Failure

The Tier B harness SHALL surface the genuine failure cause and exit code when a step fails; the
`cleanup()` trap MUST NOT overwrite or bury the real failure.

#### Scenario: Build failure is attributed and exit code preserved

- **WHEN** `xcodebuild build-for-testing` fails
- **THEN** the harness reports that the `build-for-testing` stage failed, preserves that stage's
  output, and exits with a non-zero code reflecting the real failure (NOT an `unbound variable`
  message)

#### Scenario: Test failure is distinguishable from a build failure

- **WHEN** `xcodebuild test-without-building` fails with real test failures (not a perms timeout)
- **THEN** the harness reports that the `test-without-building` stage failed and propagates its
  exit code, distinct from the build-stage and the perms-timeout SKIP paths

#### Scenario: Perms-timeout SKIP path is unaffected

- **WHEN** the test run fails with a recognized accessibility/automation perms-timeout signature
- **THEN** the harness still exits 0 with the existing non-failing SKIP message, unchanged by
  this fix

### Requirement: Tier B Real Failures Are Triaged and Filed

Once the harness surfaces the previously-masked Tier B failures, each SHALL be categorized and
filed as a tracked issue rather than silently bypassed.

#### Scenario: Surfaced failures are categorized and filed

- **WHEN** the fixed harness is run and surfaces the real Tier B failures
- **THEN** each failure is categorized (Swift build error / real test regression / env-perms)
  and filed as a beads issue under the `test-infrastructure` capability, linked to the harness
  fix — without being blind-fixed in this change

# test-infrastructure

## ADDED Requirements

### Requirement: Tier B Build Compiles SwiftPM C Dependencies

The Tier B XCUITest harness's `build-for-testing` step SHALL compile the project's SwiftPM C
dependencies (including the transitive `cmark-gfm` C target) successfully under the active Xcode
toolchain, without explicitly-built-module `.pcm` resolution failures.

#### Scenario: build-for-testing compiles cmark-gfm

- **WHEN** the Tier B harness runs `xcodebuild build-for-testing` for the `nexus-mac` scheme
- **THEN** the `cmark-gfm` C target compiles without a `module file ... not found` error for
  `_DarwinFoundation*.pcm`, and the build-for-testing stage exits 0

#### Scenario: build and test steps share a consistent artifact strategy

- **WHEN** the harness runs `build-for-testing` and then `test-without-building`
- **THEN** both steps resolve the same built product and SwiftPM artifacts (consistent
  derived-data / cloned-packages strategy), so the test step finds the product the build step
  produced

### Requirement: Tier B Gate Passes Without SKIP_TIER_B_RUN

Once the build fix lands, the Tier B pre-push gate SHALL run to its real outcome without
requiring the `SKIP_TIER_B_RUN` escape hatch to get past the build stage.

#### Scenario: Full harness run reaches the test stage

- **WHEN** the harness runs end-to-end WITHOUT `SKIP_TIER_B_RUN`
- **THEN** it passes `build-for-testing` and proceeds to `test-without-building` (reaching either
  a real test result or the existing graceful perms-timeout SKIP) — it no longer aborts at the
  build stage

#### Scenario: The escape hatch remains available

- **WHEN** `SKIP_TIER_B_RUN=1` is set
- **THEN** the harness still skips with its non-failing message (the sanctioned narrow skip is
  preserved, not removed)

# test-infrastructure

## ADDED Requirements

### Requirement: Correctness Tests Avoid Load-Sensitive Real-Time SLAs

Agent correctness tests observing async events MUST assert correctness with a generous event-driven deadline, not a tight wall-clock latency bound that flakes under machine load (fs.watch, debounced re-poll, and bus emissions all jitter under load).

#### Scenario: Spec-watcher progress test waits for the event, not a 2s budget

- **WHEN** the SpecB 5.2 spec-watcher test asserts that a tasks.md checkbox-count change emits a
  `progress` SpecTransition
- **THEN** it waits for the transition with a generous deadline and asserts the transition's
  payload correctness (`transition === "progress"`, the progress spec name, `completed`/`total`
  reflecting the update), WITHOUT a hard `elapsed < 2000ms` assertion

#### Scenario: Any retained latency bound catches only gross regressions

- **WHEN** the test retains any latency assertion at all
- **THEN** the bound is generous enough (>= 5000ms) that normal scheduling jitter under
  concurrent load cannot fail it — only a gross regression would

#### Scenario: The test is stable under repeated runs

- **WHEN** the spec-watcher fs.watch test suite is run repeatedly (e.g. 15+ iterations)
- **THEN** the SpecB 5.2 test passes every time with no timing-related flake

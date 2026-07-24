# Quality Gate Hardening

## ADDED Requirements

### Requirement: CI workflow documentation MUST reflect current gate reality

The CI workflow file SHALL NOT carry stale claims that gates are red-at-base once those gates are green. When gate status changes, the workflow header MUST be updated in the same change that turns the gate.

#### Scenario: Stale red-gate header removed

- **WHEN** all documented red gates (typecheck, lint, sql-safety) verify green at HEAD
- **THEN** the workflow header states the gates are blocking and green, with no red-at-base caveats

### Requirement: Lint warnings MUST be blocking in CI

Every workspace `lint` script SHALL run eslint with `--max-warnings 0` so that new warnings fail CI instead of accumulating. A workspace may only be exempted with a reason recorded in the change that exempts it.

#### Scenario: New warning fails CI

- **WHEN** a change introduces a new eslint warning in a ratcheted workspace
- **THEN** the `pnpm lint` CI step exits non-zero and the run is red

#### Scenario: Existing warnings fixed at ratchet time

- **WHEN** the ratchet is applied
- **THEN** all pre-existing warnings are fixed in the same change, not suppressed

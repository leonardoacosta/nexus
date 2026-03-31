# Capability: Workspace Hygiene

Workspace-level cleanliness standards and prevention of artifact accumulation.

## ADDED Requirements

### Requirement: No orphaned tmp files

The workspace SHALL NOT contain orphaned `tmp.*.rs` files from failed agent attempts.

#### Scenario: Agent creates tmp file during failed edit
- **WHEN** a CC agent creates a `tmp.*.rs` file during a failed edit attempt
- **THEN** the file is excluded from git tracking via `.gitignore`
- **AND** it is not committed to the repository

### Requirement: All tests pass

The workspace SHALL have zero test failures in the default test suite.

#### Scenario: Run workspace tests
- **WHEN** `cargo test --lib` is run across all crates
- **THEN** all tests pass with zero failures

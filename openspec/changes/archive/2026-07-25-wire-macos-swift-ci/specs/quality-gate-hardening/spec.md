# Quality Gate Hardening

## ADDED Requirements

### Requirement: Swift targets MUST have a blocking CI gate

Changes under `apps/swift/**` SHALL be gated by a CI job that regenerates the Xcode project and runs the macOS test bundles (`nexus-mac-Tests`, `NexusSharedTests`); a Swift compile or test failure blocks merge.

#### Scenario: Swift regression blocks merge

- **WHEN** a PR introduces a failing NexusShared test
- **THEN** the macOS CI job is red and the PR cannot merge green

#### Scenario: TS-only changes skip the Mac job

- **WHEN** a push touches no files under `apps/swift/**` or the workflow file
- **THEN** the macOS job does not run and consumes no Mac runner minutes

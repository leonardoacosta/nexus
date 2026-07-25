# Quality Gate Hardening

## ADDED Requirements

### Requirement: A single package manager governs installs, lockfile, and CI

The repo SHALL have exactly one package manager (bun) and one lockfile (`bun.lock`): CI installs, production deploys, and developer installs all validate against the same frozen lockfile. CI SHALL fail if a second lockfile (`pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`) is ever tracked.

#### Scenario: CI validates the lockfile deploys use

- **WHEN** CI passes on a commit
- **THEN** production's `bun install --frozen-lockfile` against that commit resolves identically — no independent drift surface exists

#### Scenario: Second lockfile rejected

- **WHEN** a change adds `pnpm-lock.yaml` (or another foreign lockfile) to the tree
- **THEN** the CI guard step fails the run

#### Scenario: Lockfile drift hard-fails deploy

- **WHEN** the committed `bun.lock` does not match what bun resolves at deploy time
- **THEN** the deploy fails loudly with no silent non-frozen recovery install

## ADDED Requirements

### Requirement: Next.js Frontend Test Alignment
Acceptance and component tests for the Next.js app (`apps/nextjs`) SHALL assert against the
actual rendered output of current components. Tests MUST be updated whenever a component refactor
changes the DOM structure or visible text.

#### Scenario: AC-13 session count asserted from table columns
- **WHEN** `ProjectsPoller` renders projects using the `ProjectsTable` layout
- **AND** project "co" has `activeSessions = 2` and `totalSessions = 4`
- **THEN** the Active column cell for that row contains the value `2`
- **AND** the Total column cell for that row contains the value `4`
- **AND** no test SHALL assert the combined string `"2 active"` which is never rendered as a single node

#### Scenario: AC-15 empty state shows current message
- **WHEN** `ProjectsPoller` receives an empty `initialProjects` array
- **THEN** the text `"No projects in registry"` is present in the document
- **AND** no test SHALL assert the string `NEXUS_PROJECTS_DIR` which was removed in commit 9f9d030

#### Scenario: AC-15 zero active sessions asserted from table columns
- **WHEN** a project has `activeSessions = 0`
- **THEN** the Active column cell for that row contains the value `0`
- **AND** no test SHALL assert the combined string `"0 active"` which is never rendered as a single node

#### Scenario: Test suite runs clean
- **WHEN** `vitest run` is executed in `apps/nextjs`
- **THEN** all test files pass with zero failures
- **AND** the currently failing 4 tests (AC-13 × 2, AC-15 × 2) are no longer reported as failures

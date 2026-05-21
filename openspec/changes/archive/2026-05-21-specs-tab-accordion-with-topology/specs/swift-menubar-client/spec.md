# swift-menubar-client Specification Delta

## ADDED Requirements

### Requirement: SpecsView groups specs as collapsible project accordions

The Nexus.app SpecsView SHALL render each project as a `DisclosureGroup`
(accordion). Default state is collapsed. User-toggled expansion state
MUST persist across app launches via UserDefaults, keyed
per-project-slug.

#### Scenario: accordion starts collapsed on first launch

- **GIVEN** Nexus.app is launched for the first time with no
  persisted accordion state
- **WHEN** the user opens the Specs tab
- **THEN** every project accordion is collapsed
- **AND** only project headers are visible (no spec rows)

#### Scenario: expansion persists across launches

- **GIVEN** the user expanded the `nx` accordion on a previous launch
- **WHEN** Nexus.app is relaunched and the user opens the Specs tab
- **THEN** the `nx` accordion is expanded
- **AND** other accordions retain their persisted state

#### Scenario: empty project hides the accordion

- **WHEN** a project's spec list is empty
- **THEN** the accordion is not rendered for that project (no empty
  shells)

### Requirement: Project headers surface active-session indicator

Each project accordion header SHALL display a pulsing green dot when
at least one active CC session's `cwd` matches the project's directory
path (`~/dev/<slug>/`) or the session's `gitOwnerRepo` matches the
project's registered repo. Inactive projects show no dot.

#### Scenario: active session in project dir lights the dot

- **GIVEN** an active session row exists with `cwd: "/home/nyaptor/dev/oo"`
  and `status: "active"`
- **WHEN** the Specs tab renders the `oo` accordion header
- **THEN** a pulsing green dot is visible adjacent to the project
  slug
- **AND** hovering / tapping the dot reveals tooltip
  `"1 active session"`

#### Scenario: multiple sessions show count badge

- **GIVEN** 3 active sessions all with `cwd` under `~/dev/ws/`
- **WHEN** the `ws` accordion header renders
- **THEN** the dot is visible
- **AND** the tooltip reads `"3 active sessions"`

#### Scenario: no active session hides the dot

- **WHEN** no active session matches the project
- **THEN** no dot is rendered on the accordion header

### Requirement: SpecsView surfaces wave-plan topology

The SpecsView SHALL surface wave-plan topology when an active run
exists. When the agent's `GET /wave-plans/active` returns a non-empty
projection, the SpecsView MUST decorate spec rows AND project headers
with wave-plan metadata.

#### Scenario: spec in active wave plan gets wave chip + status dot

- **GIVEN** the active wave plan includes spec
  `{name: "fix-credential-source-divergence", wave: 2, status: "in_progress"}`
- **WHEN** that spec's row renders
- **THEN** a chip `[W2]` is rendered after the progress bar
- **AND** a blue dot (status: in_progress) appears adjacent to the chip

#### Scenario: completed spec shows green dot

- **GIVEN** a spec has `status: "completed"` in the active wave plan
- **WHEN** the row renders
- **THEN** the status dot is green

#### Scenario: failed spec shows red dot

- **GIVEN** a spec has `status: "failed"`
- **WHEN** the row renders
- **THEN** the status dot is red

#### Scenario: project header shows wave-plan rollup chip

- **GIVEN** the active wave plan contains 3 specs in project `nx`,
  and 1 of them has `status: "in_progress"`
- **WHEN** the `nx` accordion header renders
- **THEN** the header shows a chip `[W2 · 1 dispatched]` or similar
  rollup format
- **AND** the chip is visible without expanding the accordion

#### Scenario: no active wave plan hides all wave decorations

- **WHEN** `/wave-plans/active` returns `{runId: null, specStatuses: []}`
- **THEN** no wave chips appear on any spec row or project header
- **AND** the accordion still functions normally (collapse / session
  dot unaffected)

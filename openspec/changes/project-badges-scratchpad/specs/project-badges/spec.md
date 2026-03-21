## ADDED Requirements

### Requirement: Project Activity Badges

Each project row on the Projects screen SHALL display visual badges indicating project health:

1. **Activity status dot** — a colored dot reflecting the aggregate status of sessions in the
   project:
   - Green (`#00D26A`) if any session is `Active`
   - Yellow/amber (`#FFB700`) if all sessions are `Idle` (none active)
   - Dim (`#666666`) if all sessions are `Stale` or no sessions exist
   - Red (`#FF3B3B`) if any session is `Errored` (takes precedence over green/yellow)
2. **Session count** — the total number of sessions in the project (already exists in
   `ProjectSummary.total`, now displayed alongside the badge dot)
3. **Last activity timestamp** — a relative time string (e.g., "2m ago", "1h ago") derived from
   the most recent `last_heartbeat` across all sessions belonging to that project. If the project
   has no sessions, display "-".

The badge data SHALL be computed from the existing session registry. No new RPCs or agent-side
changes are required.

#### Scenario: Project with mixed session statuses

- **WHEN** a project has 3 sessions: 1 Active, 1 Idle, 1 Stale
- **THEN** the activity dot is green (any Active session promotes the project to green)
- **AND** the session count displays "3"
- **AND** the last activity shows the age of the most recent heartbeat among all 3 sessions

#### Scenario: Project with all idle sessions

- **WHEN** a project has 2 sessions, both Idle
- **THEN** the activity dot is yellow/amber
- **AND** the last activity shows the age of the most recent heartbeat

#### Scenario: Project with errored session

- **WHEN** a project has sessions and at least one is Errored
- **THEN** the activity dot is red regardless of other session statuses

#### Scenario: Project with no sessions

- **WHEN** a project has 0 sessions (e.g., removed between polls)
- **THEN** the activity dot is dim
- **AND** the last activity displays "-"

### Requirement: Project Scratchpad Notes

The TUI SHALL provide a per-project scratchpad for freeform text notes. Users press `e` on a
selected project row to open a text editor overlay.

1. The overlay SHALL be a bordered text area rendered on top of the Projects screen.
2. The overlay SHALL display the project name in the border title.
3. The user SHALL type freely; newlines are supported via `Enter`.
4. The user SHALL press `Esc` to close the overlay and auto-save.
5. Notes SHALL be persisted to `~/.config/nexus/project-notes.toml`.
6. Notes SHALL be loaded on TUI startup and available immediately.
7. If no notes exist for a project, the scratchpad SHALL open empty.
8. The Projects screen SHALL display a `[N]` indicator on rows that have scratchpad notes.

#### Scenario: Creating a new scratchpad note

- **WHEN** user navigates to a project with no existing notes and presses `e`
- **THEN** an empty text editor overlay opens with the project name in the title
- **AND** after typing and pressing `Esc`, the note is saved to `project-notes.toml`
- **AND** the project row shows a `[N]` indicator

#### Scenario: Editing an existing scratchpad note

- **WHEN** user presses `e` on a project that already has notes
- **THEN** the overlay opens pre-populated with the existing note text
- **AND** the cursor is at the end of the text
- **AND** changes are saved on `Esc`

#### Scenario: Notes persist across TUI restarts

- **WHEN** user saves a note, quits the TUI, and relaunches
- **THEN** the note is loaded from `project-notes.toml` and displayed in the scratchpad

### Requirement: Project Notes Persistence

The system SHALL store per-project notes in a TOML file at
`~/.config/nexus/project-notes.toml`.

1. The file format SHALL use project names as keys and note text as string values.
2. The system SHALL create the file if it does not exist on first save.
3. The system SHALL handle missing or malformed files gracefully (log warning, start empty).
4. Writing SHALL be atomic: write to a temporary file then rename.

#### Scenario: TOML file format

- **WHEN** notes exist for projects "nexus" and "otaku-odyssey"
- **THEN** the file contains:
  ```toml
  [notes]
  nexus = "Working on badges feature"
  otaku-odyssey = "Deploy after stripe fix\nCheck e2e"
  ```

#### Scenario: Missing config file on startup

- **WHEN** `project-notes.toml` does not exist
- **THEN** the system starts with an empty notes map
- **AND** creates the file on first save

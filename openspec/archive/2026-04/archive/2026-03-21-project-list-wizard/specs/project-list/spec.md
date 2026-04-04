## ADDED Requirements

### Requirement: ListProjects RPC

The `NexusAgent` gRPC service SHALL expose a `ListProjects` RPC that accepts a
`ListProjectsRequest` (empty message) and returns a `ListProjectsResponse` containing a sorted,
deduplicated list of project name strings.

The agent SHALL scan `~/.claude/projects/` on each invocation, read directory names, extract
project names by taking the last path segment after `-dev-` in the directory name (e.g.,
`-home-nyaptor-dev-nexus` yields `nexus`). If no `-dev-` segment is found, the full directory
name SHALL be used as-is. Entries starting with `.` SHALL be excluded. The result SHALL be sorted
alphabetically and deduplicated.

If `~/.claude/projects/` does not exist or is empty, the RPC SHALL return an empty list (not an
error).

#### Scenario: Agent returns known projects

- **WHEN** `~/.claude/projects/` contains directories `-home-user-dev-nexus`,
  `-home-user-dev-nexus`, `-home-user-dev-oo`
- **THEN** `ListProjects` returns `["nexus", "oo"]` (sorted, deduplicated)

#### Scenario: Projects directory does not exist

- **WHEN** `~/.claude/projects/` does not exist on the agent machine
- **THEN** `ListProjects` returns an empty list with no error

#### Scenario: Projects directory is empty

- **WHEN** `~/.claude/projects/` exists but contains no subdirectories
- **THEN** `ListProjects` returns an empty list with no error

### Requirement: TUI Project Select Widget

The TUI start session wizard SHALL replace the free-text project input step with a selectable
project list. When the wizard transitions to the project step, the TUI SHALL call `ListProjects`
on the selected agent and render the results as a scrollable list widget.

The widget SHALL use the same visual pattern as `render_agent_select`: a title line ("select
project (j/k, Enter):"), a list of project names with a selection indicator, and primary/surface
brand colors. The selected item SHALL be highlighted with `PRIMARY_DIM` background.

Navigation SHALL use `j`/`k` or arrow keys to move selection, Enter to confirm, and Esc to cancel
the entire wizard.

#### Scenario: User selects a project from the list

- **WHEN** the wizard reaches the project step
- **AND** the agent returns projects `["nexus", "oo", "tc"]`
- **THEN** the TUI renders a list with three entries
- **AND** the user navigates with `j`/`k` and presses Enter on "oo"
- **AND** the wizard advances to the cwd step with `start_project` set to `"oo"`

#### Scenario: No projects available

- **WHEN** the wizard reaches the project step
- **AND** the agent returns an empty project list
- **THEN** the TUI renders "no projects found" in the select widget
- **AND** the user can press Esc to cancel the wizard

### Requirement: Type-Ahead Filtering

The project select widget SHALL support type-ahead filtering. As the user types characters, the
displayed list SHALL be filtered to show only projects whose names contain the typed substring
(case-insensitive). Backspace SHALL remove the last typed character and update the filter. The
filter query SHALL be displayed in the widget header.

#### Scenario: Filter narrows project list

- **WHEN** the project list contains `["nexus", "oo", "tc", "tl"]`
- **AND** the user types `t`
- **THEN** the list shows only `["tc", "tl"]`
- **AND** the selection index resets to 0

#### Scenario: Filter with no matches

- **WHEN** the user types a filter string that matches no projects
- **THEN** the list shows "no matches"
- **AND** Enter does nothing (no selection possible)

### Requirement: Cwd Auto-Fill from Selection

When a project is selected from the project list, the wizard SHALL auto-fill the `start_cwd` field
to `~/dev/<project>` where `<project>` is the selected project name. This matches the existing
behavior of the text-input flow, now triggered by list selection instead of manual typing.

#### Scenario: Cwd auto-filled after project selection

- **WHEN** the user selects "nexus" from the project list
- **THEN** `start_cwd` is set to `"~/dev/nexus"`
- **AND** the wizard advances to the cwd confirmation step

### Requirement: InputMode State Machine Update

The `InputMode` enum SHALL include a `StartSessionProjectSelect` variant that represents the
project list selection step. The keyboard dispatch SHALL route events to the project select
handler when in this mode.

The wizard flow SHALL be: `StartSessionAgent` (if multiple agents) -> `StartSessionProjectSelect`
-> `StartSessionCwd` -> submit RPC.

The existing `StartSessionProject` text-input mode SHALL be removed (replaced entirely by
`StartSessionProjectSelect`).

#### Scenario: Mode transitions through wizard

- **WHEN** the user presses `n` with one connected agent
- **THEN** the input mode transitions to `StartSessionProjectSelect`
- **AND** after selecting a project, transitions to `StartSessionCwd`
- **AND** after confirming cwd, the `StartSession` RPC is called

#### Scenario: Esc cancels from project select

- **WHEN** the input mode is `StartSessionProjectSelect`
- **AND** the user presses Esc
- **THEN** the input mode transitions to `Normal`
- **AND** the wizard state is cleared

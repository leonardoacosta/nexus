## ADDED Requirements

### Requirement: Session Detail Screen

The TUI SHALL provide a Session Detail screen that displays complete metadata for a single session.
The screen SHALL be accessible by pressing Enter on a selected session in the Dashboard.

The detail screen SHALL display the following fields as key-value pairs with box-drawing borders:
session ID, PID, project, branch, cwd, started_at, age (human-readable duration), status (with
color-coded dot), spec, command, agent, session type ([M] for managed, [A] for ad-hoc), and tmux
session name (for managed sessions only).

The status dot SHALL use brand colors: Active green (#00D26A), Idle amber (#FFB700), Stale dim
(#666666), Errored red (#FF3B3B).

The title SHALL be "SESSION DETAIL" in uppercase bold primary green, consistent with the dashboard
title style.

#### Scenario: View detail for an active managed session

- **WHEN** a user presses Enter on a managed session in the Dashboard
- **THEN** the Detail screen renders with all session metadata fields populated
- **AND** the status dot is green (#00D26A)
- **AND** session type shows `[M]`
- **AND** tmux session name is displayed (e.g., `nx-a1b2c3d4`)

#### Scenario: View detail for an ad-hoc session

- **WHEN** a user presses Enter on an ad-hoc session in the Dashboard
- **THEN** the Detail screen renders with all session metadata fields populated
- **AND** session type shows `[A]`
- **AND** tmux session name field shows `--` or is omitted

#### Scenario: Navigate back to Dashboard

- **WHEN** the user presses `q` on the Detail screen
- **THEN** the TUI returns to the Dashboard with the previously selected row preserved

### Requirement: Command Palette

The TUI SHALL provide a Command Palette overlay activated by pressing `:` or `/` in Normal mode.
The palette SHALL render on top of the current screen with an input line and a filtered results list.

The palette SHALL support fuzzy search via case-insensitive substring matching across:
- Session entries (labeled as `project:branch (agent-name)`)
- Screen navigation entries (Dashboard, Detail, Health, Projects)
- Action entries (Start Session, Stop Session)

Results SHALL update on every keystroke. Navigation within results SHALL use `j`/`k` or arrow keys.
Enter SHALL execute the selected entry. Esc SHALL dismiss the palette without action.

#### Scenario: Search for a session by project name

- **WHEN** the user presses `:` to open the palette
- **AND** types `oo`
- **THEN** the results list shows all sessions with project matching "oo"
- **AND** pressing Enter on a session navigates to its Detail screen

#### Scenario: Switch to Health screen via palette

- **WHEN** the user opens the palette and types `health`
- **THEN** the results list shows the "Health" screen entry
- **AND** pressing Enter switches to the Health screen

#### Scenario: Dismiss palette without action

- **WHEN** the user presses Esc while the palette is open
- **THEN** the palette closes
- **AND** the TUI returns to the previous screen and input mode

#### Scenario: Start session from palette

- **WHEN** the user opens the palette and selects "Start Session"
- **THEN** the start session wizard begins (agent selection if multiple, then project, then cwd)

### Requirement: Start Session Flow

The TUI SHALL allow users to start a new managed Claude Code session by pressing `n` from the
Dashboard or selecting "Start Session" from the Command Palette.

The flow SHALL proceed as follows:
1. If multiple agents are configured, present an agent selection list with `j`/`k` navigation
2. If only one agent is configured, skip agent selection
3. Prompt for project code (text input with `project:` label)
4. Prompt for working directory (text input with `cwd:` label)
5. Call `StartSession` gRPC RPC on the selected agent
6. On success, return to Dashboard; the new managed session SHALL appear on the next poll cycle
7. On error, display the error message in the status bar and return to Normal mode

The started session SHALL appear in the Dashboard with `[M]` type indicator.

#### Scenario: Start session on single agent

- **WHEN** only one agent is configured
- **AND** the user presses `n`
- **THEN** the agent selection step is skipped
- **AND** the user is prompted for project code and cwd
- **AND** after confirming, `StartSession` RPC is called on the sole agent
- **AND** on success, the Dashboard shows the new session as `[M]`

#### Scenario: Start session with multiple agents

- **WHEN** multiple agents are configured
- **AND** the user presses `n`
- **THEN** an agent selection list is displayed with agent names
- **AND** the user selects an agent with `j`/`k` and Enter
- **AND** then enters project code and cwd
- **AND** the `StartSession` RPC is called on the selected agent

#### Scenario: Cancel start session

- **WHEN** the user presses Esc at any step of the start session wizard
- **THEN** the wizard is cancelled
- **AND** the TUI returns to Normal mode on the Dashboard

#### Scenario: Start session RPC fails

- **WHEN** the `StartSession` RPC returns an error (e.g., tmux not available)
- **THEN** the error message is displayed in the status bar
- **AND** the TUI returns to Normal mode

### Requirement: Input Mode State Machine

The TUI app state SHALL track an `InputMode` enum that distinguishes between:
- `Normal` -- standard keyboard shortcuts active (j/k navigation, screen switching, etc.)
- `PaletteInput` -- palette is open, keystrokes go to the search query
- `StartSessionAgent` -- start session wizard, agent selection step
- `StartSessionProject` -- start session wizard, project code text input
- `StartSessionCwd` -- start session wizard, cwd text input

Keyboard dispatch SHALL route events based on the current `InputMode`. Mode transitions SHALL
be: Normal -> PaletteInput (`:` or `/`), Normal -> StartSessionAgent or StartSessionProject (`n`),
any input mode -> Normal (Esc).

#### Scenario: Keyboard input routed by mode

- **WHEN** the input mode is `PaletteInput`
- **AND** the user presses `j`
- **THEN** `j` navigates the palette results list (not the dashboard)

#### Scenario: Esc returns to Normal from any input mode

- **WHEN** the input mode is `StartSessionProject`
- **AND** the user presses Esc
- **THEN** the input mode transitions to `Normal`
- **AND** the start session wizard state is cleared

## ADDED Requirements

### Requirement: Pane Geometry Reporting

The agent SHALL report the source tmux pane's geometry (column count and row
count) to a connected PTY stream viewer, so the viewer can size its terminal
emulator to match the byte stream's layout. The geometry SHALL be delivered to
the viewer at attach time and again whenever the source pane's geometry changes.

#### Scenario: Geometry delivered at attach

- **WHEN** a viewer connects to `/sessions/{id}/stream` for a tmux-backed session
- **THEN** the agent sends the current pane geometry (`cols`, `rows`) to the
  viewer before or alongside the initial scrollback replay

#### Scenario: Geometry updates on source resize

- **WHEN** a viewer is attached to a tmux-backed session
- **AND** the source tmux pane is resized (e.g. a real user resizes their terminal)
- **THEN** the agent sends the updated pane geometry to the viewer

#### Scenario: Non-tmux source reports its own geometry

- **WHEN** a viewer connects to a session backed by `NodePtySource` (not tmux)
- **THEN** the agent reports the PTY's configured `cols` and `rows` to the viewer

### Requirement: Viewer-Driven Pane Resize (Take-Over)

The agent SHALL accept a viewer-initiated resize request for a managed session
and apply it to the underlying tmux pane, so a viewer can claim the full window
size. The resize SHALL be rejected for non-managed sessions. Before applying the
first viewer-driven resize for a session, the agent SHALL record the pane's
original geometry.

#### Scenario: Managed session accepts viewer resize

- **WHEN** a viewer sends a resize request (`cols`, `rows`) for a session whose
  `sessionType` is `managed`
- **THEN** the agent resizes the underlying tmux pane to the requested dimensions
- **AND** the agent records the pane's pre-resize geometry if not already recorded

#### Scenario: Non-managed session rejects viewer resize

- **WHEN** a viewer sends a resize request for a session whose `sessionType` is
  not `managed`
- **THEN** the agent does NOT resize the tmux pane
- **AND** the agent returns an error response indicating resize is not permitted

#### Scenario: Invalid dimensions rejected

- **WHEN** a viewer sends a resize request with non-positive or out-of-range
  `cols`/`rows`
- **THEN** the agent does NOT resize the tmux pane
- **AND** the agent returns an error response

### Requirement: Pane Geometry Auto-Restore On Detach

The agent SHALL restore a tmux pane to its recorded original geometry when the
last take-over viewer detaches, so a co-viewer of the same pane is not left with
an altered terminal size after the take-over viewer leaves.

#### Scenario: Restore after last take-over viewer disconnects

- **WHEN** a session's pane was resized by a take-over viewer
- **AND** the last take-over viewer for that session disconnects
- **THEN** the agent resizes the tmux pane back to its recorded original geometry
- **AND** the agent clears the recorded original geometry for that session

#### Scenario: No restore when no take-over occurred

- **WHEN** a viewer that never issued a resize request disconnects
- **THEN** the agent does NOT resize the tmux pane

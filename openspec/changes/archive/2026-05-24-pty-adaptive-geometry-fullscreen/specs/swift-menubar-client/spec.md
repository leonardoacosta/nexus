## ADDED Requirements

### Requirement: PTY Viewer Locks Grid To Reported Pane Geometry

The macOS PTY viewer SHALL, by default, constrain its SwiftTerm grid to the pane
geometry reported by the agent, so the rendered output aligns with the byte
stream's layout and does not jumble. When the agent reports a geometry change,
the viewer SHALL update its grid to match.

#### Scenario: Grid sized to reported geometry on attach

- **WHEN** the PTY viewer attaches to a session and receives a pane geometry
  (`cols`, `rows`) from the agent
- **AND** the viewer is in the default (lock) mode
- **THEN** the SwiftTerm grid is set to the reported `cols` x `rows`
- **AND** rendered output is not horizontally misaligned relative to the source

#### Scenario: Grid follows source geometry changes

- **WHEN** the PTY viewer is in lock mode
- **AND** the agent reports an updated pane geometry
- **THEN** the SwiftTerm grid is resized to the new reported geometry

#### Scenario: View larger than pane is letterboxed, not stretched

- **WHEN** the PTY viewer's available frame is larger than the reported pane
  geometry in lock mode
- **THEN** the SwiftTerm grid remains at the reported geometry
- **AND** the surrounding area is empty space (the grid is not stretched to fill)

### Requirement: PTY Viewer Take-Over Toggle

The macOS PTY viewer SHALL expose a take-over toggle in its header for managed
sessions. When enabled, the viewer SHALL forward its own grid size to the agent
as a resize request and render at that size. When disabled (or on detach), the
viewer SHALL return to lock mode. The toggle SHALL be hidden or disabled for
non-managed sessions and SHALL NOT require a confirmation dialog.

#### Scenario: Toggle visible only for managed sessions

- **WHEN** the PTY viewer renders for a session whose `sessionType` is `managed`
- **THEN** the take-over toggle is present and enabled
- **WHEN** the session's `sessionType` is not `managed`
- **THEN** the take-over toggle is hidden or disabled

#### Scenario: Enabling take-over forwards grid size

- **WHEN** the user enables the take-over toggle on a managed session
- **THEN** the viewer sends a resize request with its current grid size to the
  agent
- **AND** the viewer renders at its own grid size (no longer locked to the
  reported pane geometry)
- **AND** no confirmation dialog is shown

#### Scenario: Take-over forwards subsequent size changes

- **WHEN** take-over mode is enabled
- **AND** the viewer's grid size changes (e.g. the user resizes the window)
- **THEN** the viewer forwards the new grid size to the agent as a resize request

#### Scenario: Disabling take-over returns to lock mode

- **WHEN** take-over mode is enabled
- **AND** the user disables the toggle (or the viewer detaches)
- **THEN** the viewer returns to lock mode and re-applies the reported pane
  geometry on the next attach

### Requirement: Dashboard Window Enters Native Fullscreen Reliably

The macOS dashboard `Window` SHALL reliably enter native fullscreen (its own
Space) via the green title-bar button. The `.fullScreenPrimary` collection
behavior SHALL be applied to the underlying `NSWindow` even when the window is
not resolved on the first runloop tick after the SwiftUI scene mounts.

#### Scenario: Green button enters a fullscreen Space

- **WHEN** the dashboard window is open
- **AND** the user clicks the green title-bar button
- **THEN** the window enters native fullscreen as its own Space (not a zoom/maximize)

#### Scenario: Collection behavior applied despite deferred window resolution

- **WHEN** the dashboard scene mounts and the underlying `NSWindow` is not yet
  attached on the first runloop tick
- **THEN** the `.fullScreenPrimary` collection behavior is still applied once the
  window resolves
- **AND** applying it more than once has no adverse effect (idempotent)

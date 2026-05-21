# swift-menubar-client Specification Delta

## ADDED Requirements

### Requirement: SessionRow is tappable on managed sessions

Nexus.app SessionsView SHALL render a tap-affordance on each row
whose `sessionType == "managed"`. Tapping the row MUST navigate to
PtyViewer loaded with that session's id, label, and tmuxTarget.

#### Scenario: tap on managed session opens PtyViewer

- **GIVEN** the Sessions tab is open and a row with
  `sessionType: "managed"` is visible
- **WHEN** the user taps the row
- **THEN** the dashboard's right pane navigates to PtyViewer
- **AND** PtyViewer subscribes to `GET /sessions/<id>/stream`
- **AND** the row's selection highlight appears

#### Scenario: non-managed row shows untracked badge instead

- **GIVEN** a session row with `sessionType: "raw"` or any non-managed
  value
- **WHEN** the row renders
- **THEN** a muted `untracked` badge appears in the trailing column
- **AND** the row does NOT respond to taps
- **AND** the cursor does NOT change to the pointer affordance on
  hover

### Requirement: PtyViewer header shows session label + close affordance

The PtyViewer SHALL render a header containing the session label
(gitOwnerRepo or projectId or cwd basename) and a close button that
returns the dashboard's right pane to the default empty state.

#### Scenario: header shows project label

- **GIVEN** a session with `gitOwnerRepo: "leonardoacosta/oo"` is
  opened in PtyViewer
- **WHEN** the viewer renders
- **THEN** the header shows `leonardoacosta/oo` as the title

#### Scenario: close affordance returns to default pane

- **GIVEN** PtyViewer is open
- **WHEN** the user clicks the close button
- **THEN** the right pane reverts to its default view
- **AND** the PTY stream subscription is cancelled
- **AND** SwiftTerm releases its terminal buffer

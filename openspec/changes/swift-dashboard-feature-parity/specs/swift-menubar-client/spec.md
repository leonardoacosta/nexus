## ADDED Requirements

### Requirement: Swift app SHALL provide a full dashboard surface

The Swift menu bar app SHALL include SwiftUI views covering every page the web dashboard exposes today: sessions, specs, projects, credentials, failures, notifications, settings, health, integrations. Each view exposes the same user actions available on web.

#### Scenario: every web page has a Swift equivalent
- **GIVEN** the parity audit (docs/plan/spine-migration/p5-parity-audit.md) lists every web page
- **WHEN** the audit is walked
- **THEN** every row has a matching Swift view checked off

### Requirement: Swift dashboard SHALL include a PTY viewer via SwiftTerm

A read-only terminal pane (SwiftTerm TerminalView) SHALL render bytes from `GET /sessions/$id/stream` (WebSocket). Supports color, scrollback, copy/paste. Equivalent to the xterm.js viewer in apps/nextjs.

#### Scenario: PTY viewer renders a live session
- **GIVEN** session `oo-7f3a` is running and the Swift dashboard has a viewer open
- **WHEN** the user types into the tmux session (via SSH outside the app)
- **THEN** the SwiftTerm pane shows the keystrokes echoing within 100ms

### Requirement: parity audit SHALL gate P5.2 (web removal)

A file `docs/plan/spine-migration/p5-parity-audit.md` SHALL list every web page and its Swift equivalent. P5.2 (`retire-web-dashboard-infra`) SHALL NOT start until every row in the audit is checked.

#### Scenario: audit blocks premature removal
- **GIVEN** the audit has 2 unchecked rows
- **WHEN** P5.2's tasks are attempted
- **THEN** the gate fails with "parity audit incomplete: 2 unchecked rows"

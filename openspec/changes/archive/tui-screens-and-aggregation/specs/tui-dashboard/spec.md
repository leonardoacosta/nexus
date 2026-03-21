## ADDED Requirements

### Requirement: App State and Screen Navigation
The TUI SHALL maintain an App state struct that tracks the current screen, aggregated agent data,
and selected row index. The TUI SHALL support three screens: Dashboard, Health, and Projects.
The Tab key SHALL cycle forward through screens. Shift+Tab SHALL cycle backward. Screen state
SHALL persist across screen switches (selected index, scroll position).

#### Scenario: Screen cycling via Tab
- **WHEN** the user presses Tab on the Dashboard screen
- **THEN** the TUI switches to the Health screen
- **WHEN** the user presses Tab on the Health screen
- **THEN** the TUI switches to the Projects screen
- **WHEN** the user presses Tab on the Projects screen
- **THEN** the TUI wraps back to the Dashboard screen

#### Scenario: App quit
- **WHEN** the user presses `q` or Ctrl+C
- **THEN** the TUI restores the terminal to its original state and exits cleanly

### Requirement: Multi-Agent Session Aggregation
The TUI SHALL query all configured agents (via NexusClient from spec 4) and merge their sessions
into a unified list. Each agent's sessions SHALL be tagged with the agent's name and connection
status. Disconnected agents SHALL be excluded from the session list but shown in status indicators.
Aggregation SHALL run on a 2-second polling interval via a background tokio task.

#### Scenario: All agents connected
- **WHEN** two agents are configured and both respond successfully
- **THEN** the Dashboard displays sessions from both agents, merged and grouped by project

#### Scenario: One agent disconnected
- **WHEN** one agent fails to respond within the 2s timeout
- **THEN** that agent's sessions are removed from the Dashboard
- **AND** the status bar shows the disconnected agent with a ✖ indicator
- **AND** the Health screen shows "last seen {duration} ago" for that agent

#### Scenario: Auto-refresh polling
- **WHEN** 2 seconds elapse since the last poll
- **THEN** the TUI queries all agents and updates the displayed data
- **AND** the selected row persists by matching session ID (falls back to clamped index)

### Requirement: Dashboard Screen
The Dashboard screen SHALL display all sessions grouped by project. Each session row SHALL show:
status dot (● Active, ○ Idle, ◌ Stale, ✖ Error), type indicator ([M] managed, [A] ad-hoc),
project code, branch, session age, current command/spec, and a braille sparkline. Sessions
with no project SHALL be grouped under "(no project)". Groups SHALL be sorted alphabetically.
The selected row SHALL be highlighted with inverted background (#0A4A2A). The title bar SHALL
display "SESSION DASHBOARD" in uppercase bold green. The status bar SHALL display agent count,
session count, and TUI uptime.

#### Scenario: Session row rendering
- **WHEN** sessions exist from connected agents
- **THEN** each row displays: `● [M] oo  main  2m  /apply add-auth  ⣿⣸⣰⠸`

#### Scenario: j/k navigation
- **WHEN** the user presses `j` or Down arrow
- **THEN** the selected row moves down by one (clamped at last row)
- **WHEN** the user presses `k` or Up arrow
- **THEN** the selected row moves up by one (clamped at first row)

#### Scenario: Empty state
- **WHEN** no sessions are available from any agent
- **THEN** the Dashboard displays a centered message: "no sessions"

### Requirement: Health Screen
The Health screen SHALL display per-machine metrics for each configured agent. For connected
agents: CPU percentage, RAM used/total in GB, disk used/total in GB, load average (1/5/15 min),
uptime, and Docker container status (if available). For disconnected agents: a ✖ indicator in
red with "last seen {duration} ago" text. The title bar SHALL display "HEALTH OVERVIEW" in
uppercase bold green.

#### Scenario: Connected agent with Docker
- **WHEN** an agent is connected and reports Docker containers
- **THEN** the Health screen displays machine metrics and a Docker container list with running/stopped status

#### Scenario: Disconnected agent display
- **WHEN** an agent has ConnectionStatus::Disconnected
- **THEN** the Health screen shows the agent name with ✖ in red and "last seen 3m ago"

### Requirement: Projects Screen
The Projects screen SHALL display a table of all projects with active sessions. Each row SHALL
show: project code, total session count, breakdown by status (active/idle/stale/error), and which
agents host sessions for that project. The selected row SHALL be navigable with j/k. The title
bar SHALL display "PROJECT OVERVIEW" in uppercase bold green.

#### Scenario: Project table rendering
- **WHEN** sessions exist across multiple projects
- **THEN** each project row displays: `oo  5 sessions  3● 1○ 1◌  homelab, macbook`

#### Scenario: No projects
- **WHEN** no sessions are available
- **THEN** the Projects screen displays a centered message: "no projects"

### Requirement: Brand Color Compliance
The TUI SHALL use the brand color palette for all rendering: primary green (#00D26A) for active
status and focused elements, amber (#FFB700) for idle/warning, red (#FF3B3B) for error/disconnected,
neutral text (#C0C0C0) for body content, dim (#666666) for borders and inactive elements. Selected
rows SHALL use primary dim (#0A4A2A) background. Screen titles SHALL be uppercase bold in primary
green.

#### Scenario: Status dot colors
- **WHEN** rendering a session with Active status
- **THEN** the dot ● is rendered in #00D26A (green)
- **WHEN** rendering a session with Idle status
- **THEN** the dot ○ is rendered in #FFB700 (amber)
- **WHEN** rendering a session with Stale status
- **THEN** the dot ◌ is rendered in #666666 (dim)
- **WHEN** rendering a session with Errored status
- **THEN** the dot ✖ is rendered in #FF3B3B (red)

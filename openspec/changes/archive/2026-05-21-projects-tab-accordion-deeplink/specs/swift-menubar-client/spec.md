# swift-menubar-client Delta

## ADDED Requirements

### Requirement: projects-accordion-row
The Projects tab MUST render each project as an expandable accordion row showing project name, active-session count, git branch chip, and an expand/collapse chevron in the collapsed state. The expanded state MUST additionally show git metadata (ahead/behind/dirty indicators, last-commit author + time) and a nested list of live sessions. Expand state MUST persist across launches via `@AppStorage` keyed by project id; entries for removed projects MUST be pruned on next `ProjectsView.task()`.

#### Scenario: project with no active sessions defaults collapsed
- **Given** project `nx` has 0 active sessions on first launch
- **When** the Projects tab renders
- **Then** the row is collapsed; only project name + total-session count + branch chip are visible

#### Scenario: project with active sessions defaults expanded
- **Given** project `nx` has 2 active sessions on first launch (no @AppStorage entry yet)
- **When** the Projects tab renders
- **Then** the row is expanded; git metadata and both session rows are visible

#### Scenario: user override persists across launches
- **Given** the user collapsed an active-session project
- **When** the app is relaunched
- **Then** the row stays collapsed; the @AppStorage entry overrides the active-session default

#### Scenario: removed project pruned from storage
- **Given** project `tc` was removed from the registry but its @AppStorage entry still exists
- **When** `ProjectsView.task()` runs
- **Then** the orphan entry is deleted; subsequent storage reads do not include it

### Requirement: project-row-git-metadata
The accordion row in both collapsed and expanded states MUST surface git metadata from the `GET /projects` response. Collapsed: a single branch chip (e.g. `main` in green for clean, `feat/foo*` with asterisk when dirty). Expanded: ahead/behind counters (`↑3 ↓0`), dirty indicator (orange dot when true), last-commit author + relative time (e.g. `leo · 2h ago`). `git_metadata: null` MUST render an explicit "not a git repo" hint rather than a blank space.

#### Scenario: clean repo on main
- **Given** `git_metadata: { branch: "main", ahead: 0, behind: 0, dirty: false, last_commit: { author: "leo", ts: "2026-05-21T18:00:00Z" } }`
- **When** the row is rendered
- **Then** collapsed shows `main` chip in green; expanded adds `↑0 ↓0`, no dirty dot, `leo · just now`

#### Scenario: dirty feature branch
- **Given** `git_metadata: { branch: "feat/foo", ahead: 3, behind: 0, dirty: true, last_commit: {...} }`
- **When** the row is rendered
- **Then** collapsed shows `feat/foo*` chip; expanded adds `↑3 ↓0`, orange dirty dot

#### Scenario: detached HEAD
- **Given** `git_metadata` has `branch: null` but other fields populated
- **When** the row is rendered
- **Then** the branch chip shows `(detached)` in monospace; ahead/behind counters are hidden

#### Scenario: non-git directory
- **Given** `git_metadata: null`
- **When** the row is rendered
- **Then** the row shows the project name without a branch chip; expanded shows `(not a git repo)` in the metadata pane

### Requirement: session-deep-link-from-projects
Clicking a session row inside the expanded accordion MUST switch the dashboard tab to Sessions, scroll the matching session row into view, and open the session's PTY in the Sessions tab's right pane. The deep-link MUST cancel any prior pending deep-link still draining. The Sessions tab's existing tap-to-open path MUST remain unchanged for direct interactions.

#### Scenario: click session inside Projects accordion
- **Given** the user is on the Projects tab; project `nx` is expanded with session `nx-1234567890` visible
- **When** the user clicks the `nx-1234567890` row
- **Then** the dashboard tab switches to Sessions, the `nx-1234567890` row scrolls into view, and the right pane shows the PTY for that session within 500ms

#### Scenario: rapid double-click cancels first deep-link
- **Given** the user clicked session A and the PTY WebSocket handshake is still pending
- **When** the user clicks session B 200ms later
- **Then** the deep-link for A is cancelled, B's deep-link proceeds, and the right pane settles on B's PTY (not A's)

#### Scenario: deep-link to unknown session ID
- **Given** the project list has a stale session id that no longer exists on any agent
- **When** the user clicks the stale row
- **Then** the dashboard tab switches to Sessions, no row is scrolled into view, no PTY opens; an info-level banner reads "session no longer available"

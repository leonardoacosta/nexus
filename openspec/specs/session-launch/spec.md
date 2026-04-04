# session-launch Specification

## Purpose
TBD - created by archiving change add-project-management. Update Purpose after archive.
## Requirements
### Requirement: session-start-endpoint
The nexus-agent MUST expose `POST /session/start` which SHALL accept `{ project: string, path: string }` and spawn a detached tmux window in `path` running `claude`. It MUST return `{ session_name: string, started: true }` on success or `{ error: string }` with appropriate HTTP status on failure.

#### Scenario: successful session launch
Given tmux is available and `path` is a valid directory
When `POST /session/start { project: "nx", path: "/home/user/dev/nx" }` is called
Then a tmux window named `nx-<timestamp>` is created, `claude` is running in it, and response is `200 { session_name: "nx-1234567890", started: true }`

#### Scenario: tmux not available
Given the `tmux` binary is not on PATH
When `POST /session/start` is called
Then response is `503 { error: "tmux not found — install tmux on this agent" }`

#### Scenario: path does not exist
Given `path` points to a non-existent directory
When `POST /session/start` is called
Then response is `400 { error: "project path does not exist: /path/to/missing" }`

#### Scenario: session name uniqueness
Given `~/dev/nx` already has a tmux session named `nx-1234567890`
When `POST /session/start` with the same project is called 1 ms later
Then a new unique session name is used (timestamp differs), no conflict

### Requirement: start-session-ui
`ProjectCard` MUST show a "Start Session" button. Clicking it SHALL call the `startSession` server action and apply an optimistic "Starting…" label on the card, re-enabling after the next poll cycle confirms a new session or after 10 s timeout.

#### Scenario: start session button visible
Given the Projects page renders a `ProjectCard` for a discovered project
Then a "Start Session" button is visible on the card

#### Scenario: optimistic state on click
Given the user clicks "Start Session" on the `nx` card
Then the button immediately shows "Starting…" and is disabled while the request is in flight

#### Scenario: poller picks up new session
Given `POST /session/start` succeeded and the agent registered a new session
When the 5 s poller fires
Then the `nx` card shows `active_sessions: 1` and the button returns to "Start Session"

#### Scenario: start session error shown
Given `POST /session/start` returns an error (e.g. tmux not found)
Then the button returns to "Start Session" and an error message is displayed on the card


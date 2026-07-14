## MODIFIED Requirements

### Requirement: session-start-endpoint
The nexus-agent MUST expose `POST /session/start` (and, additively, `POST /sessions/start` as a
`/sessions`-route-family-consistent alias of the same handler — `redesign-status-usage-
endpoints` task 2.7) which SHALL accept `{ project: string, path: string }` and spawn a detached
tmux window in `path` running `claude`. It MUST return `{ session_name: string, started: true }`
on success or `{ error: string }` with appropriate HTTP status on failure. Both paths route to
the identical handler — no behavior differs between them; the alias exists purely so the
`/sessions` route family (which now also owns lifecycle-adjacent status composition, per
`session-persistence`) is discoverable as a single naming convention. The original `/session/start`
path is NOT removed — no existing caller is broken by this change.

#### Scenario: successful session launch
Given tmux is available and `path` is a valid directory
When `POST /session/start { project: "nx", path: "/home/user/dev/nx" }` is called
Then a tmux window named `nx-<timestamp>` is created, `claude` is running in it, and response is `200 { session_name: "nx-1234567890", started: true }`

#### Scenario: alias path behaves identically
Given the same preconditions as the previous scenario
When `POST /sessions/start { project: "nx", path: "/home/user/dev/nx" }` is called instead
Then the response is identical in shape and effect to calling `POST /session/start`

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

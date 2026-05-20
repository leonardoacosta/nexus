# swift-menubar-client Specification Delta

## ADDED Requirements

### Requirement: SpecsView presents a two-column layout with markdown detail

The Nexus.app SpecsView SHALL present a two-column layout: the existing
project-grouped spec list on the left, a markdown-rendered detail pane
on the right. The detail pane MUST load the selected spec's proposal,
design (if present), and tasks markdown via the agent's HTTP API.

#### Scenario: selecting a spec loads its proposal

- **GIVEN** the SpecsView is open with at least one spec listed
- **WHEN** the user clicks a spec row
- **THEN** the detail pane fetches `proposal.md` for that spec
- **AND** the content renders as formatted markdown (bold, italic,
  inline code, links applied)

#### Scenario: detail pane tabs switch between proposal/design/tasks

- **GIVEN** a spec is selected and its detail pane is visible
- **WHEN** the user clicks the "design" tab
- **THEN** the pane fetches and renders `design.md` for that spec
- **AND** the tab indicator reflects the active document

#### Scenario: missing file shows empty state

- **GIVEN** a spec has no `design.md`
- **WHEN** the user clicks the "design" tab
- **THEN** the pane shows an empty state ("No design document for
  this spec") without throwing
- **AND** the markdown renderer is NOT invoked with empty content

#### Scenario: no spec selected shows hint state

- **GIVEN** no spec is selected
- **WHEN** the user opens the Specs tab for the first time
- **THEN** the detail pane shows a hint ("Select a spec to view its
  contents")
- **AND** the column proportions remain stable

### Requirement: Agent exposes spec content via dedicated endpoint

The agent SHALL serve markdown file content via
`GET /specs/{project}/{name}/{file}` where `file` is one of
`proposal`, `design`, `tasks` (without extension). The handler MUST
sanitize paths (reject `..`, enforce the canonical
`<workspace-root>/<project>/openspec/changes/<spec>/<file>.md`
pattern).

#### Scenario: valid request returns markdown bytes

- **GIVEN** `~/dev/nx/openspec/changes/foo/proposal.md` exists
- **WHEN** the dashboard fetches `GET /specs/nx/foo/proposal`
- **THEN** the response status is 200
- **AND** the body is the file's raw markdown content
- **AND** the Content-Type header is `text/markdown; charset=utf-8`

#### Scenario: traversal attempt is rejected

- **WHEN** a request like `GET /specs/nx/foo/../../etc/passwd`
  reaches the handler
- **THEN** the response status is 400 (bad request)
- **AND** no filesystem access occurs outside the workspace root

#### Scenario: missing spec returns 404

- **WHEN** a request for a non-existent spec is made
- **THEN** the response is 404 with a small JSON body
  `{"error":"not found"}`
- **AND** the handler does NOT leak filesystem error details

### Requirement: NotificationsView places settings as a bottom toolbar

The NotificationsView SHALL use a `VStack` layout: the history list
(full window width) above, a compact horizontal settings toolbar
pinned to the bottom. The `HSplitView` settings-pane allocation MUST
NOT consume horizontal real-estate from the body.

#### Scenario: notification body uses full width

- **GIVEN** the NotificationsView is visible at a 700px window width
- **WHEN** a notification arrives with a 200-character body
- **THEN** the body text wraps using the full window width (minus
  standard padding)
- **AND** the body is NOT truncated mid-sentence by a narrow column

#### Scenario: bottom toolbar exposes all settings

- **GIVEN** the NotificationsView is visible
- **WHEN** the user looks at the bottom of the panel
- **THEN** the toolbar contains: Mode picker (Mix/Meet), Signal-only
  toggle, Suppression stepper (0m default), Ducking menu
- **AND** all controls remain functional and bound to the same
  underlying model as before

#### Scenario: toolbar fits in a narrow window

- **WHEN** the window is resized down to 480px wide
- **THEN** the toolbar controls remain visible (compact icons + short
  labels) without horizontal scrolling
- **AND** the body pane shrinks proportionally without breaking layout

### Requirement: SystemSpeechSynthesizer serializes utterances

The `SystemSpeechSynthesizer` SHALL serialize concurrent `speak()`
calls. Each call MUST await the prior `/usr/bin/say` subprocess's
exit before launching the next. Three rapid calls produce three
sequential utterances, NOT three overlapping ones.

#### Scenario: rapid speak calls produce sequential audio

- **GIVEN** SystemSpeechSynthesizer is freshly instantiated
- **WHEN** three `speak()` calls fire within 100ms (text: "alpha",
  "bravo", "charlie")
- **THEN** the audio output produces "alpha" first (in full), then
  "bravo" (in full), then "charlie" — never overlapping
- **AND** the total wall-clock equals the sum of the three utterance
  durations

#### Scenario: speak returns immediately, work is queued

- **WHEN** `speak("hello")` is called
- **THEN** the function call returns within 10ms (does NOT block on
  audio completion)
- **AND** the audio begins playing within the next 100ms (subprocess
  spawn latency)

#### Scenario: subprocess failure does not stall the queue

- **WHEN** a `/usr/bin/say` invocation fails (e.g., empty argument
  vector)
- **THEN** the error is logged via os_log
- **AND** the next queued utterance still runs
- **AND** the queue does NOT permanently jam

# spec-watcher Specification

## Purpose
TBD - created by archiving change add-spec-watcher. Update Purpose after archive.
## Requirements
### Requirement: The system MUST proactively poll spec and beads status
The agent MUST runs a background service that enumerates all registered projects via `ProjectRegistry::all()`, polls `openspec list --json` and `bd stats --json` per project every 60 seconds, and updates the ProjectStatusCache.

#### Scenario: Normal polling cycle
Given 5 registered projects with openspec directories
When the 60-second poll interval fires
Then the service runs collectors for each project and updates the cache

#### Scenario: Project without openspec directory
Given a registered project at ~/dev/cc with no openspec/ directory
When the poll cycle enumerates projects
Then that project is skipped without error

#### Scenario: Staggered polling to reduce load
Given 15 registered projects
When the poll cycle runs
Then projects are polled in batches of 3-5 with a short delay between batches

### Requirement: The system MUST detect state transitions and emit TTS notifications
The service MUST compares each poll result with the previous snapshot and emits TTS notifications for new specs, task completion changes, all-tasks-complete, and spec archived events.

#### Scenario: New spec detected
Given project "oo" had 2 specs in the previous poll
When the current poll finds 3 specs
Then a TTS notification is emitted: "New spec add-user-auth in oo"

#### Scenario: Task completion progress
Given spec "add-user-auth" in "oo" was at 3/10 tasks
When the current poll finds 7/10 tasks
Then a TTS notification is emitted: "oo: add-user-auth progress 7 of 10 tasks"

#### Scenario: All tasks complete
Given spec "add-user-auth" in "oo" was at 9/10 tasks
When the current poll finds 10/10 tasks
Then a TTS notification is emitted: "oo: add-user-auth all tasks complete — ready to archive"

#### Scenario: Spec archived
Given spec "add-user-auth" was present in "oo" changes last poll
When the current poll no longer finds it in changes (moved to archive)
Then a TTS notification is emitted: "oo: add-user-auth archived"

#### Scenario: Notification coalescing
Given 3 specs changed in the same poll cycle across 2 projects
When notifications are generated
Then they are batched into a single TTS message within a 5-second window

### Requirement: The system MUST detect openspec writes via filesystem watching
The spec-watcher service MUST establish a filesystem watch on each registered project's `openspec/changes/` directory (shallow, non-recursive) and trigger a targeted re-poll of the affected change within 1 second of any write event. The watch MUST coexist with the existing 60-second poll; polling is retained as a safety net for missed events.

#### Scenario: tasks.md checkbox tick triggers targeted re-poll
- **Given** project "oo" is registered and its `openspec/changes/add-user-auth/tasks.md` is being watched
- **When** a user ticks a checkbox in `tasks.md` and saves
- **Then** the spec-watcher re-polls only `add-user-auth` within 1 second and emits a progress transition if `completedTasks` increased

#### Scenario: new proposal directory appears
- **Given** project "oo" is registered with 2 tracked specs
- **When** a new directory `openspec/changes/new-feature/` appears on disk
- **Then** the spec-watcher detects the directory-create event and emits a "new spec" transition within 1 second

#### Scenario: inotify watch limit hit
- **Given** the agent has already established watches for 20 projects
- **When** adding a new watch returns `ENOSPC`
- **Then** the service logs a warning, records the project as degraded, and continues serving that project with 60-second poll only

#### Scenario: debounce collapses burst of writes
- **Given** a single spec receives 5 write events within 250 ms (e.g., `bd sync` updating `tasks.md` multiple times)
- **When** the debounce window (300 ms) elapses
- **Then** the spec-watcher performs exactly one targeted re-poll for that spec

---

### Requirement: The system MUST expose spec transitions as a Server-Sent Events stream
The agent MUST expose `GET /specs/events` as an SSE endpoint. When the spec-watcher emits a `SpecTransition` to `lifecycleBus`, the SSE handler MUST forward a corresponding event to all connected clients. Events MUST be coalesced in a 5-second window to avoid spamming clients during bursts.

#### Scenario: client receives transition within the coalescing window
- **Given** a browser is subscribed to `/specs/events` via EventSource
- **When** the spec-watcher emits a progress transition for spec `add-user-auth` in project `oo`
- **Then** the client receives a message of type `progress` with payload `{ project: "oo", spec: "add-user-auth", completedTasks, totalTasks }` within 5 seconds

#### Scenario: multiple transitions coalesce
- **Given** 3 specs transition within 2 seconds across 2 projects
- **When** the 5-second coalescing window elapses
- **Then** the SSE stream emits a batched message containing all 3 transitions, not 3 separate messages

#### Scenario: SSE stream survives disconnect
- **Given** a client's EventSource connection drops
- **When** the client reconnects
- **Then** the agent accepts the new connection without error (stream is stateless; recovery of missed events is the client's responsibility via refetch)

### Requirement: Module decomposition by concern
The spec-watcher capability MUST be implemented as a directory of concern-specific modules (`apps/agent/src/services/spec-watcher/`) rather than a single file. No file in the decomposition MAY exceed 250 lines.

#### Scenario: A new contributor opens the codebase
- **GIVEN** the spec-watcher feature is implemented
- **WHEN** the contributor inspects `apps/agent/src/services/`
- **THEN** they find a `spec-watcher/` directory with files named for concerns (constants, parser, poller, watcher, tts, index) rather than a single 707-line file

### Requirement: Pure parser layer
Parsing logic for spec event streams MUST live in `spec-watcher/parser.ts`, a module with no side effects — no subprocess spawning, no filesystem watching, no network I/O, no TTS.

#### Scenario: Unit test runs without subprocess
- **GIVEN** a JSON snapshot of `openspec list` output
- **WHEN** a unit test calls the parser directly (parseSpecList, processProjectSpecs)
- **THEN** no subprocess is spawned, no filesystem is watched, and the test returns a deterministic SpecSnapshot in under 50ms

### Requirement: Consumer API stability
The public exports of the spec-watcher module (including `startSpecWatcher`, `parseSpecList`, and any test-only hooks such as `_getWatchDegradedForTest` and `_projectState`) MUST remain importable from the same specifier they were before the split. Consumers MUST NOT need to update import paths.

#### Scenario: Existing consumer imports are unchanged
- **GIVEN** a file that imports from `@/services/spec-watcher` (or the equivalent relative path)
- **WHEN** the split is complete
- **THEN** the import resolves to the lifecycle index module and returns the same symbols as before the split

### Requirement: Spec watcher scans configured workspace roots

The agent's spec-watcher service SHALL scan configured workspace roots
for OpenSpec proposals on startup AND at a configured polling interval.
Default workspace root is `~/dev`; default poll interval is 60 seconds.

#### Scenario: startup scan populates /specs immediately

- **GIVEN** the agent boots with `~/dev/nx/openspec/changes/foo/` and
  `~/dev/nx/openspec/changes/bar/` present
- **WHEN** the agent finishes initialization (within 5 seconds)
- **THEN** `GET /specs` returns at least two entries with `name=foo` and
  `name=bar`
- **AND** each entry has `project=nx`

#### Scenario: poll interval picks up new specs

- **GIVEN** the spec-watcher is running with poll interval 60s
- **WHEN** the operator creates a new directory
  `~/dev/nx/openspec/changes/baz/` with at least a `proposal.md`
- **THEN** within 90 seconds, `GET /specs` returns an entry with
  `name=baz`

#### Scenario: removed spec disappears from /specs

- **GIVEN** a spec `foo` is in /specs results
- **WHEN** the operator archives it (moves to
  `~/dev/nx/openspec/changes/archive/<date>-foo/`)
- **THEN** within 90 seconds, `GET /specs` no longer returns `foo`
  (archived specs are out of scope per this spec's "Out of Scope")

### Requirement: Workspace roots are configurable via config file

The spec-watcher SHALL read its workspace roots from
`~/.config/nexus/spec-watcher.toml` (or the agent's canonical config
location). The default roots MUST include `~/dev` if no config file is
present.

#### Scenario: default roots used when config missing

- **WHEN** the config file does not exist
- **THEN** the spec-watcher scans `~/dev/*/openspec/changes/`
- **AND** the agent logs the resolved root list at startup

#### Scenario: custom roots from config

- **GIVEN** the config file contains `roots = ["~/dev", "~/work/clientX"]`
- **WHEN** the spec-watcher starts
- **THEN** it scans BOTH glob expansions

### Requirement: Each spec emission includes filesystem marker tri-state

The spec-watcher SHALL include filesystem marker booleans on each emit.
Per agent-payload-completeness (archived 2026-05-20), the spec-watcher
emit MUST include `has_proposal`, `has_design`, `has_tasks` booleans
derived from filesystem presence at scan time. This requirement
re-affirms that contract under the broader "spec-watcher actually
scans" guarantee.

#### Scenario: complete spec reports all three markers true

- **GIVEN** a spec directory with proposal.md + design.md + tasks.md
- **WHEN** the spec-watcher emits it
- **THEN** the row has `has_proposal=true`, `has_design=true`,
  `has_tasks=true`

#### Scenario: proposal-only spec reports partial tri-state

- **GIVEN** a spec directory with only proposal.md
- **WHEN** the spec-watcher emits it
- **THEN** the row has `has_proposal=true`, `has_design=false`,
  `has_tasks=false`

### Requirement: Completed task count reflects tasks.md state

The spec-watcher SHALL emit completedTasks and totalTasks fields
matching tasks.md state. For each emitted spec, the `completedTasks`
and `totalTasks` fields MUST reflect the count of `- [x]` and total
`- [ ]`/`- [x]` lines in the spec's `tasks.md`. If tasks.md is missing,
both counts are 0.

#### Scenario: completed count matches checkbox grep

- **GIVEN** a tasks.md with 5 `- [x]` lines and 3 `- [ ]` lines
- **WHEN** the spec-watcher emits the row
- **THEN** `completedTasks=5` and `totalTasks=8`

#### Scenario: empty tasks.md yields zeroes

- **GIVEN** a tasks.md with no checkbox lines (only headers/prose)
- **WHEN** the spec-watcher emits the row
- **THEN** `completedTasks=0` and `totalTasks=0`

### Requirement: Agent exposes active wave-plan status via /wave-plans/active

The agent SHALL expose `GET /wave-plans/active` returning the current
in-flight `/apply` or `/apply:all` run's wave-plan projection. The
response MUST include per-spec status entries with wave number, phase,
status enum, and dispatch timestamp.

#### Scenario: active run returns full projection

- **GIVEN** the agent's local `docs/apply/active.txt` points to a
  valid run id AND `docs/apply/<run-id>/wave-plan.json` is readable
- **WHEN** the dashboard fetches `GET /wave-plans/active`
- **THEN** the response status is 200
- **AND** the body contains `runId`, `planName`, `status`,
  `currentWave`, `currentPhase`, and `specStatuses[]`
- **AND** each `specStatuses[]` entry has `name`, `wave`, `status`,
  `phase`, `dispatchedAt` (nullable)

#### Scenario: no active run returns empty payload

- **WHEN** `docs/apply/active.txt` does not exist
- **THEN** the response is 200 with body
  `{runId: null, specStatuses: []}`
- **AND** no fields are omitted (downstream clients can rely on the
  shape)

#### Scenario: malformed wave plan does not crash agent

- **GIVEN** `docs/apply/<run-id>/wave-plan.json` exists but is
  malformed JSON or missing required keys
- **WHEN** the agent reads it
- **THEN** the response is 200 with body
  `{runId: null, specStatuses: [], error: "<reason>"}`
- **AND** an os_log warn is emitted with the parse error
- **AND** the agent does NOT throw

#### Scenario: spec status values are canonical

- **WHEN** the wave plan's internal status is one of
  `queued|dispatched|in_progress|completed|failed|skipped`
- **THEN** the wire's `specStatuses[].status` field MUST emit one of
  those values
- **AND** unknown internal statuses fall back to `queued`

### Requirement: The system MUST detect beads writes via filesystem watching

The spec-watcher service MUST establish a filesystem watch on each registered project's
`.beads/` directory (the PARENT directory, filtered to `issues.jsonl` — `bd`'s auto-export
rewrites the file via atomic rename-over, which kills a single-file inotify watch) and trigger a
targeted beads recount within 1 second of a rewrite, debounced at 300 ms. An unconditional
60-second poll fallback MUST coexist with the watch. The recount MUST parse `issues.jsonl`
directly with zero `bd` CLI invocations on the hot path.

#### Scenario: bd close rewrites issues.jsonl and triggers a recount

- **Given** project "nexus" is registered and its `.beads/issues.jsonl` is being watched
- **When** `bd close nx-abcde` causes auto-export to rename a temp file over `issues.jsonl`
- **Then** the service recounts beads for "nexus" within 1 second and the watch survives the rename (parent-dir watch, not single-file)

#### Scenario: debounce collapses burst of rewrites

- **Given** a `bd` batch operation rewrites `issues.jsonl` 5 times within 250 ms
- **When** the 300 ms debounce window elapses
- **Then** exactly one recount runs for that project

#### Scenario: project without a .beads directory

- **Given** a registered project has no `.beads/` directory
- **When** watch establishment is attempted
- **Then** the project is recorded as beads-absent, no watch is created, and spec watching for that project is unaffected

#### Scenario: watch failure degrades to poll-only

- **Given** establishing the `.beads/` watch returns `ENOSPC`
- **When** the service continues
- **Then** it logs a warning and serves that project via the 60-second poll fallback only

#### Scenario: malformed JSONL keeps previous counts

- **Given** a recount reads an `issues.jsonl` that is truncated mid-write or contains an invalid line
- **When** parsing fails
- **Then** the previous counts are retained, the failure is logged, and no snapshot or event is produced from the bad read

### Requirement: The system MUST emit BeadTransition events on count changes

The service MUST publish a `BeadTransition` event on the lifecycle bus — symmetric with
`SpecTransition` — whenever a recount changes a project's unlinked ready or blocked totals. The
payload MUST carry `project`, `readyUnlinked`, `blockedUnlinked`, and `openTotal`. The event
MUST be exposed on the existing SSE stream.

#### Scenario: count change publishes exactly one event

- **Given** project "nexus" last counted 5 ready-unlinked and 2 blocked-unlinked beads
- **When** a recount finds 6 ready-unlinked and 2 blocked-unlinked
- **Then** one `BeadTransition` event is published with readyUnlinked=6, blockedUnlinked=2

#### Scenario: unchanged counts publish nothing

- **Given** a recount produces identical totals to the previous recount
- **When** the recount completes
- **Then** no `BeadTransition` event is published

#### Scenario: SSE client receives the transition

- **Given** a client is subscribed to the agent's SSE stream
- **When** a `BeadTransition` is published on the lifecycle bus
- **Then** the client receives the event envelope with seq, timestamp, and the payload fields


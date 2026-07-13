# spec-watcher Delta

## ADDED Requirements

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

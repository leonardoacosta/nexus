## MODIFIED Requirements

### Requirement: The agent SHALL compute fleet bead exceptions from local stores without ever throwing or blocking the event loop

nexus-agent SHALL read every `~/dev/*/.beads` store via Dolt (two-query
whole-graph read, discovery via `.beads/metadata.json`) falling back to parsing
`issues.jsonl`, and compute exception classes: P0/P1 open issues, in_progress
claims older than 7 days, ready-head older than 30 days, and unarchived
openspec proposal count per repo. A missing/corrupt store SHALL be skipped and
reported as a `skipped` entry, never a thrown error. Every filesystem read
performed during this scan SHALL be non-blocking (asynchronous), and the scan
SHALL yield the event loop between stores so a multi-megabyte read does not
stall other in-flight agent work (socket hook ingest, WebSocket frames, other
routes) for the duration of the scan.

#### Scenario: Dolt unavailable falls back to JSONL
- **GIVEN** a repo whose Dolt server is not running
- **WHEN** the fleet scan runs
- **THEN** that repo's exceptions are computed from issues.jsonl

#### Scenario: Corrupt store is skipped, not fatal
- **GIVEN** one repo with an unparseable issues.jsonl among healthy repos
- **WHEN** the fleet scan runs
- **THEN** healthy repos' exceptions are returned and the corrupt repo appears under `skipped`

#### Scenario: A large store's read does not stall other in-flight work

- **GIVEN** the fleet scan is reading a multi-megabyte `issues.jsonl` store
- **WHEN** another agent route or socket hook event arrives concurrently
- **THEN** that concurrent work is not blocked for the full duration of the large read

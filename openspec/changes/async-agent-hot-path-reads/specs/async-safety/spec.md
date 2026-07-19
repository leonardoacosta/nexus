# Capability: async-safety

## ADDED Requirements

### Requirement: Async Context-Usage Tail Read
`collectContextUsage` SHALL derive a session's context-window usage from a bounded trailing
window of the transcript file, read via `node:fs/promises`, instead of a synchronous whole-file
`readFileSync`.

#### Scenario: Large transcript read does not block the event loop
- **WHEN** a hook event with a `transcript_path` pointing at a 10MB+ transcript arrives on the
  socket-ingest path
- **THEN** `collectContextUsage` reads only the trailing window of the file via an async read
- **AND** the Bun event loop remains free to process other concurrent socket events during the
  read

#### Scenario: Transcript smaller than the tail window is still read correctly
- **WHEN** the transcript file is smaller than the configured tail-read window
- **THEN** `collectContextUsage` reads the whole file
- **AND** returns the same result as the prior synchronous whole-file implementation

#### Scenario: Fail-soft contract is preserved
- **WHEN** the transcript file is missing, unreadable, malformed, or contains no
  assistant-with-usage line
- **THEN** `collectContextUsage` resolves to `null`
- **AND** never throws

### Requirement: Async tasks.md Resolution
`resolveTasksMd` in `bead-rollup.ts` SHALL resolve a proposal's `tasks.md` (live directory, then
archive) using `node:fs/promises`, instead of synchronous `readFileSync`/`readdirSync`.

#### Scenario: Concurrent per-project spec rollups do not serialize on the event loop
- **WHEN** `GET /specs/all` computes bead rollups for multiple projects inside `runPool(8)`
- **THEN** each project's `resolveTasksMd` call performs its file read asynchronously
- **AND** the bounded concurrency of `runPool(8)` is not nullified by synchronous I/O

#### Scenario: Live-then-archive fallback is preserved
- **WHEN** a spec's `tasks.md` does not exist in the live `openspec/changes/<spec>/` directory
- **THEN** `resolveTasksMd` scans `openspec/changes/archive/` for a matching entry
  (exact name or `-<specName>` suffix) asynchronously
- **AND** returns `null` only when neither location has a readable `tasks.md`

### Requirement: Shared Async Frontmatter/Tasks Resolver
`readProposalFrontmatter` (`routes/specs.ts`) and `resolveTasksMd` (`bead-rollup.ts`) SHALL share
one async live-then-archive file resolver, parameterized by filename, instead of each
independently duplicating the sync lookup-and-fallback logic.

#### Scenario: Single spec detail request performs its reads asynchronously
- **WHEN** `GET /specs/:project/:name` calls `readProposalFrontmatter`
- **THEN** the underlying live-then-archive file read is performed via the shared async resolver
- **AND** the returned frontmatter map is unchanged from the prior synchronous implementation

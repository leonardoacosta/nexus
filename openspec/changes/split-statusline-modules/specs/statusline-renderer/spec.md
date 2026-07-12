## ADDED Requirements

### Requirement: The statusline usage-cache wire contract SHALL be defined in exactly one shared location

The `UsagePeriod`/`UsageResponse`/`CachedUsage` shape shared between the statusline's usage-cache reader and the agent's usage-cache writer SHALL be declared in exactly one importable, types-only location that both processes import from — never hand-duplicated interfaces kept in sync by convention.

#### Scenario: A shape change is caught at typecheck time, not at runtime

- **GIVEN** the shared contract's `CachedUsage` shape changes
- **WHEN** the agent-side writer or the statusline-side reader is typechecked without a matching update on both sides
- **THEN** the typecheck fails, rather than the two processes silently diverging on the on-disk file format

#### Scenario: The contract package carries no runtime dependency

- **GIVEN** the statusline binary is compiled via `bun build --compile`
- **WHEN** the shared contract package is imported
- **THEN** the import is erased at compile time (types only) and contributes no runtime dependency to the compiled binary

### Requirement: The statusline implementation SHALL be organized as single-responsibility modules, not one growing entrypoint file

`apps/nexus-statusline`'s implementation SHALL be split across modules each scoped to one
responsibility (cache I/O, rendering, project resolution, usage resolution, context guarding,
session-context harvesting, speed estimation, agent-line fetching), with the compiled-binary
entrypoint file containing only stdin parsing, orchestration, and the `main` guard — never
housing feature logic directly.

#### Scenario: A new statusline feature lands in its owning module

- **GIVEN** a new ambient status line or cache file is added to the statusline
- **WHEN** the change is implemented
- **THEN** it lands inside the module that owns that responsibility (or a new module, if none
  fits) rather than inside the entrypoint file

#### Scenario: The entrypoint file exposes no exports

- **GIVEN** the statusline's module split
- **WHEN** the entrypoint file (`index.ts`) is inspected
- **THEN** it declares zero `export` statements — every symbol another module or the test suite
  needs is exported from its owning module instead

### Requirement: Duplicated cache-file read/write idioms SHALL be consolidated into shared helpers

Every statusline cache-file read SHALL use one shared fail-soft read-parse-validate helper, and
every statusline cache-file write SHALL use one shared atomic-write helper (tmp-sibling write +
rename), rather than each cache site re-implementing the same idiom independently.

#### Scenario: A cache write is always atomic

- **GIVEN** any statusline component writes a JSON cache file
- **WHEN** the write is interrupted or fails partway through
- **THEN** the previously-committed cache file (if any) is left unchanged — no consumer ever
  observes a partially-written cache file

#### Scenario: A cache read never crashes the render on corrupt or missing data

- **GIVEN** a cache file that is missing, unreadable, or contains invalid JSON
- **WHEN** the statusline reads it
- **THEN** the read returns null rather than throwing

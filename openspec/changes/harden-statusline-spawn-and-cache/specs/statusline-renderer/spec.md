## ADDED Requirements

### Requirement: Statusline spawn sites MUST NOT interpolate untrusted values into shell command text

Every child-process invocation in `apps/nexus-statusline/src/index.ts` SHALL either use an
argv-vector call (no shell parsing of variable data) or, where a shell script is required for its
`&&`/redirect idioms, pass every variable value as a positional shell parameter (`$1`, `$2`, ...)
inside a compile-time-constant script string — never interpolated into the script text itself.

#### Scenario: git probes use argv vectors

- **GIVEN** a project directory path containing shell metacharacters (`"`, `$()`)
- **WHEN** the statusline resolves git status for that directory
- **THEN** the git command executes correctly and the metacharacters have no shell effect

#### Scenario: Background refresh scripts pass variable data positionally

- **GIVEN** a cache-refresh spawn constructed from a project-derived cache path
- **WHEN** the spawn's script text is inspected
- **THEN** the script text is a fixed constant containing no interpolated project-derived value
- **AND** the project-derived value appears only as a positional argv entry

### Requirement: The statusline audit suppression MUST describe the actual spawn shape

The D4 audit suppression entry covering the statusline binary SHALL scope to the exact production
source file and its `reason` field SHALL accurately describe why its spawn sites are trusted,
given whatever spawn mechanism is currently in use.

#### Scenario: Suppression reason matches reality

- **GIVEN** the statusline's spawn sites use argv-vector calls and positional-parameter scripts
- **WHEN** the D4 suppression stanza for the statusline is read
- **THEN** its reason text describes that mechanism, not a stale "constant-arg, no interpolation" claim that no longer holds

### Requirement: Statusline stale-while-revalidate caches MUST NOT suppress their own refresh on a corrupt read

When a cached JSON file exists with a fresh mtime but fails to parse, the statusline SHALL treat
the cache as stale and trigger a background refresh — the same as a missing or expired cache —
rather than silently returning null and waiting out the freshness TTL.

#### Scenario: Corrupt-but-fresh cache triggers a refresh

- **GIVEN** a cache file with a fresh mtime whose contents are not valid JSON
- **WHEN** the statusline reads that cache
- **THEN** it returns null for that render
- **AND** it spawns a background refresh rather than deferring to the freshness TTL

### Requirement: Concurrent statusline refresh writers MUST NOT share a tmp file path

Every detached background-refresh spawn that writes to a shared per-project cache path SHALL use
a tmp filename unique to that spawn's process, and SHALL clean up its tmp file on producer
failure.

#### Scenario: Two concurrent sessions do not interleave writes

- **GIVEN** two CC sessions in the same project both trigger a stale-cache refresh concurrently
- **WHEN** both refresh spawns run
- **THEN** each writes to a distinct tmp path
- **AND** neither spawn's output can be interleaved into the other's committed cache file

#### Scenario: A failed refresh does not commit a corrupt cache

- **GIVEN** a refresh spawn's producer command fails
- **WHEN** the spawn's shell script completes
- **THEN** the spawn's tmp file is removed
- **AND** the previously-committed cache file (if any) is left unchanged

### Requirement: Statusline per-session state-file garbage collection MUST cover every session-keyed file family

The statusline's opportunistic GC SHALL prune every per-session state-file prefix under
`~/.claude/scripts/state/` that the binary itself writes, not a subset.

#### Scenario: All three session-keyed families are pruned

- **GIVEN** aged files under each of the statusline's session-keyed file-family prefixes
- **WHEN** the GC scan runs and its probabilistic gate fires
- **THEN** every aged file across all covered prefixes is removed
- **AND** fresh files and files outside the covered prefixes are left untouched

### Requirement: The polled usage cache MUST be treated as absent once it exceeds its staleness bound

The statusline SHALL omit the usage segment when the polled usage cache's `fetched_at` timestamp
is older than a fixed maximum age, rather than rendering data of unbounded age.

#### Scenario: Fresh cache renders

- **GIVEN** a polled usage cache written within the staleness bound
- **WHEN** the statusline renders the usage segment
- **THEN** the segment renders using the cached data

#### Scenario: Stale cache is treated as absent

- **GIVEN** a polled usage cache written before the staleness bound
- **WHEN** the statusline renders
- **THEN** the usage segment is omitted rather than showing the stale values

### Requirement: The statusline package's test script MUST run its real test suite

`apps/nexus-statusline/package.json`'s `test` script SHALL invoke the package's actual colocated
test suite, so that any turbo-gated pipeline (including CI) that runs each package's `test` script
actually exercises the statusline's tests rather than reporting a false green.

#### Scenario: Package-scoped test run executes the real suite

- **GIVEN** the statusline package's `test` script
- **WHEN** it is invoked via `pnpm --filter @nexus/statusline test` or a turbo-driven `test` task
- **THEN** the colocated statusline test suite runs and its pass/fail result is reported

### Requirement: The statusline usage-cache writer MUST be covered by a dedicated unit suite

`writeStatuslineUsageFile` (the sole writer of the file the statusline's usage segment reads) SHALL have unit test coverage for every skip branch, its written payload shape, and its fail-soft behavior, using filesystem spies rather than writes to the real operator state directory.

#### Scenario: Writer coverage exists and never touches the live cache file

- **GIVEN** the writer's unit test suite runs
- **WHEN** the suite completes
- **THEN** every skip branch, the happy-path payload shape, and both fail-soft paths (db failure,
  write failure) are asserted
- **AND** the real `~/.claude/scripts/state/usage-cache.json` file is unchanged by the suite run

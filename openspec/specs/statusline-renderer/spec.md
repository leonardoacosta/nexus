# statusline-renderer Specification

## Purpose
TBD - created by archiving change fix-nexus-status-cc-payload. Update Purpose after archive.
## Requirements
### Requirement: Statusline MUST consume the canonical CC payload
The statusline SHALL parse the JSON payload piped on stdin by Claude Code's `statusLine` hook,
extracting only the fields still needed by a KEPT segment or by another repo's independent
consumer of the same payload shape: `model` (still read by other consumers even though this
package no longer renders it directly — verify at implementation time whether `model` extraction
itself can be dropped from THIS package's own parsing, or whether it's retained solely because
`CcInput`'s type is shared/re-exported elsewhere), `workspace.project_dir` (project code),
`cost.total_duration_ms` (session clock), `workspace.git_worktree` (worktree badge), and whatever
minimal identity fields the account-domain resolution needs. Fields that ONLY fed now-removed
segments (`cost.total_cost_usd`, `cost.total_lines_added`/`removed`, `output_style`,
`context_window`, `exceeds_200k_tokens`) MAY be dropped from this package's own type/parsing,
provided any SHARED type definition other repos still import remains intact (re-scoping this
package's OWN usage, not necessarily the shared type itself). The statusline MUST remain
crash-safe regardless of which fields are present or absent (unchanged from the prior
requirement version).

#### Scenario: a payload with only kept-segment fields renders successfully
- Given: a CC payload carrying `workspace.project_dir`, `cost.total_duration_ms`, and
  `workspace.git_worktree`, but no `cost.total_cost_usd`, `output_style`, or `context_window`
- When: the statusline renders
- Then: the kept segments (project code, session clock, worktree badge) render normally with no
  error, and no removed-segment code path is invoked

### Requirement: Project name MUST prefer workspace.project_dir over git

When `workspace.project_dir` is a non-empty string, the statusline MUST use `basename(project_dir)` as the project-name segment value and MUST NOT invoke `git remote get-url origin` as part of project-name resolution. The git branch and dirty-status detection calls MAY remain (they represent data not in the payload). When `workspace.project_dir` is absent, the renderer MAY fall back to the existing git-based resolution.

#### Scenario: Payload provides project_dir

- **GIVEN** stdin payload `{"workspace": {"project_dir": "/home/nyaptor/dev/oo"}}`
- **WHEN** the statusline renders
- **THEN** the project segment shows `oo`
- **AND** `git remote get-url origin` is NOT invoked (verifiable via mocked `execSync`)

#### Scenario: Missing project_dir falls back

- **GIVEN** a payload without `workspace.project_dir`
- **WHEN** the statusline renders
- **THEN** project-name resolution falls back to git (current behavior)

### Requirement: Statusline MUST remain crash-safe

The statusline binary MUST never throw an unhandled error that propagates to Claude Code. All new field consumption MUST be guarded by null/undefined checks. On any parse error, the binary MUST emit an empty string and exit 0, matching the existing contract. Adding fields MUST NOT introduce new error paths — missing fields MUST simply omit their corresponding segment.

#### Scenario: Malformed JSON does not crash

- **GIVEN** stdin contains `{not-valid-json`
- **WHEN** the statusline parses
- **THEN** the process exits 0
- **AND** emits an empty (or minimal fallback) string

#### Scenario: All new fields absent, legacy behavior preserved

- **GIVEN** payload `{"model": {"display_name": "Opus"}}`  (only the legacy supported field)
- **WHEN** the statusline renders
- **THEN** output matches the pre-change legacy rendering for the same input (model segment only)
- **AND** no new segments appear

### Requirement: Git-worktree badge

The statusline MUST render `workspace.git_worktree` as a badge immediately after the git branch segment when present (a non-`--worktree`-flag linked worktree, e.g. one created by `git worktree add` or cc's `/apply` worktree-per-spec flow). When absent, no badge renders.

#### Scenario: Worktree badge renders

- **GIVEN** stdin payload `{"workspace": {"git_worktree": "20260705-1030-abc123"}}`
- **WHEN** the statusline renders
- **THEN** a badge showing `20260705-1030-abc123` appears immediately after the git branch segment

#### Scenario: No badge outside a worktree

- **GIVEN** a stdin payload without `workspace.git_worktree`
- **WHEN** the statusline renders
- **THEN** no worktree badge appears

### Requirement: Statusline MUST guard against spurious zero context frames

The `nexus-statusline` binary MUST treat a `context_window.used_percentage` of `0` (or absent) as
*unpopulated* rather than as a literal zero. It MUST NOT render a context segment implying `100%`
remaining on such a frame. It MUST maintain a per-session last-good context snapshot keyed by
`session_id`, restore it on an unpopulated frame when the snapshot is present and fresh, and
otherwise omit the context segment for that render. On a populated (`> 0`) frame it MUST refresh
the snapshot. All snapshot reads/writes MUST be fail-soft — a missing, unreadable, or corrupt
snapshot never crashes the render.

#### Scenario: Spurious zero with a fresh non-zero snapshot restores the cached value

- **WHEN** a frame arrives with `context_window.used_percentage: 0` and a fresh per-session
  snapshot exists holding a non-zero `used_percentage`
- **THEN** the context segment renders the snapshot's remaining percentage
- **AND** the segment never shows `CTX 100%` (the inverted reading)

#### Scenario: Spurious zero with no snapshot omits the context segment

- **WHEN** a frame arrives with `context_window.used_percentage: 0` and no per-session snapshot
  exists (or the snapshot is stale)
- **THEN** the context segment is omitted from the rendered statusline for that render

#### Scenario: Populated frame refreshes the snapshot

- **WHEN** a frame arrives with `context_window.used_percentage` greater than `0`
- **THEN** the context segment renders that value
- **AND** the per-session snapshot is updated to the new value (subject to write throttling)

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

### Requirement: The statusline usage-cache wire contract SHALL be defined in exactly one shared location
The `usage-cache.json` wire shape SHALL remain defined in exactly one shared location
(`packages/statusline-contract`), consumed by nx-agent (writer) and, externally, cc-tmux's
`usage.py` (reader) — UNCHANGED from the prior requirement version. `apps/nexus-statusline`
itself is no longer a reader of this contract (its own 5H/7D rendering is removed), but the
contract's existence and single-source-of-truth property are unaffected by that.

#### Scenario: the shared contract still has a real writer and a real external reader
- Given: nx-agent writes `usage-cache.json` per the shared contract, and cc-tmux's `usage.py`
  reads it independently
- When: `apps/nexus-statusline` is inspected for its own usage of this contract
- Then: it no longer imports/reads the usage-cache shape for rendering purposes, while the
  contract itself, its writer, and cc-tmux's reader remain fully functional and unaffected

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

### Requirement: nexus-statusline SHALL push its resolved context-window reading to nx-agent on every render
nexus-statusline SHALL fire an async, non-awaited `POST /sessions/:id/context` to the local
nx-agent after `context-guard.ts`'s existing spurious-zero-guard logic resolves a value (unchanged
— the local `statusline-ctx.<sessionId>.json` snapshot and its guard behavior are not modified by
this requirement), carrying the resolved `{usedPercentage, contextWindowSize}`. This push MUST NOT
block or delay the statusline render — fire-and-forget, matching this codebase's fail-soft
convention for every other external call in the render path. A failed or slow POST MUST be
silently swallowed.

#### Scenario: Render never blocks on the push
Given nx-agent is unreachable
When the statusline renders and resolves a context value
Then the render completes and prints normally, with no added latency waiting on the POST

#### Scenario: Push carries the resolved (guarded) value, not the raw CC frame
Given CC's raw stdin frame for this render is a spurious `used_percentage: 0`
And the guard resolves the fresh cached snapshot value (`42`) instead
When the push fires
Then the POST body carries `usedPercentage: 42` (the resolved value), never the raw `0`

### Requirement: nexus-statusline SHALL NOT write the tmux-pane-keyed session-context file
`session-context.ts`'s `writeSessionContext()` export and its call site MUST be removed — a clean
replacement, not a compat shim. nexus-statusline MUST NOT write `session-context.<pane>.json` on
any render going forward. cc-tmux's session-bar context-% segment reads as absent until cc-tmux's
own (out-of-scope) follow-up starts querying `GET /sessions/:id/context` directly.

#### Scenario: No pane-keyed file is written
Given a statusline render completes with a resolved context value
When the render's side effects are inspected
Then no `session-context.<pane>.json` file is created or updated

#### Scenario: Existing orphaned pane-keyed files still get garbage-collected
Given a pane-keyed file from before this change exists on disk and has aged past its TTL
When the existing `gcSessionContext` opportunistic GC runs
Then the orphaned file is still pruned (the GC's `session-context.` prefix is unchanged — this
requirement stops the writer, not the sweep of pre-existing files)


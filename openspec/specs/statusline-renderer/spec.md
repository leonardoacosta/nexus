# statusline-renderer Specification

## Purpose
TBD - created by archiving change fix-nexus-status-cc-payload. Update Purpose after archive.
## Requirements
### Requirement: Statusline MUST consume the canonical CC payload

The `nexus-statusline` statusline binary (`apps/nexus-statusline/src/index.ts`) MUST declare a
TypeScript input type matching the canonical CC statusline payload documented at
[code.claude.com/docs/en/statusline](https://code.claude.com/docs/en/statusline), re-synced
2026-07-05. At minimum the type MUST include optional fields for `hook_event_name`, `session_id`,
`transcript_path`, `cwd`, `model` (with `id` and `display_name`), `workspace` (with `current_dir`,
`project_dir`, `git_worktree`), `version`, `output_style` (an object with `name`, NOT a bare
string), `cost` (with `total_cost_usd`, `total_duration_ms`, `total_api_duration_ms`,
`total_lines_added`, `total_lines_removed`), `context_window` (with `used_percentage`,
`context_window_size` — NOT the never-real `used_tokens`/`max_tokens`), `exceeds_200k_tokens`,
`effort` (with `level`), and `rate_limits` (with both `five_hour` and `seven_day`, each with
`used_percentage` and `resets_at`).

#### Scenario: Full 2026-07-05 payload accepted without error

- **GIVEN** the canonical 2026-07-05 CC payload (including `output_style: {name: "default"}`,
  `exceeds_200k_tokens`, `effort.level`, `rate_limits.seven_day`, `workspace.git_worktree`) is
  piped to `nexus-statusline` via stdin
- **WHEN** the binary parses the input
- **THEN** the parse MUST succeed without throwing
- **AND** all rendered segments that depend on payload fields MUST populate correctly

#### Scenario: Object-form output_style renders correctly

- **GIVEN** stdin payload `{"output_style": {"name": "tts-summary"}}`
- **WHEN** the statusline renders
- **THEN** the output-style segment MUST show an abbreviated form of `tts-summary`
- **AND** the process MUST NOT throw or render the literal string `[object Object]`

#### Scenario: Legacy bare-string output_style degrades gracefully

- **GIVEN** stdin payload `{"output_style": "tts-summary"}` (the pre-drift shape)
- **WHEN** the statusline renders
- **THEN** no error is thrown
- **AND** the output-style segment MAY be omitted (the type no longer declares this shape as valid)

### Requirement: Context bar MUST render from used_percentage

When `context_window.used_percentage` is a number between 0 and 100 inclusive, the statusline MUST render a context bar segment. The rendered "remaining" percentage MUST be computed as `100 - used_percentage`. Color banding MUST apply as before: remaining > 40% = `CTX_HIGH` mint, 20–40% = `CTX_MED` orange, < 20% = `CTX_LOW` red. The legacy field name `remaining_percentage` MUST be removed from both the type declaration and any documentation comments in the source file.

When `context_window.context_window_size` is additionally a positive number, the segment suffix MUST also show approximate absolute usage formatted as `<used>k/<size>k`, where `used = round(used_percentage / 100 x context_window_size / 1000)` and `size = round(context_window_size / 1000)`. When `context_window_size` is absent or non-positive, the percentage-only suffix renders unchanged. The payload provides no direct used-token field, so the absolute value is derived and approximate by design.

#### Scenario: Used 25% renders remaining 75% in high-color band

- **GIVEN** stdin payload `{"context_window": {"used_percentage": 25}}`
- **WHEN** the statusline renders
- **THEN** the context segment shows `75%` (or equivalent)
- **AND** uses the `CTX_HIGH` color code

#### Scenario: Used 85% renders remaining 15% in low-color band

- **GIVEN** stdin payload `{"context_window": {"used_percentage": 85}}`
- **WHEN** the statusline renders
- **THEN** the context segment shows `15%`
- **AND** uses the `CTX_LOW` color code

#### Scenario: Missing used_percentage omits segment

- **GIVEN** stdin payload with `context_window` absent or with `used_percentage` unset
- **WHEN** the statusline renders
- **THEN** the context segment MUST NOT appear in output
- **AND** no error is thrown

#### Scenario: Absolute usage suffix when context_window_size present

- **GIVEN** stdin payload `{"context_window": {"used_percentage": 42, "context_window_size": 200000}}`
- **WHEN** the statusline renders
- **THEN** the context segment suffix contains `84k/200k`
- **AND** the remaining-percentage and color banding render as before

#### Scenario: No context_window_size falls back to percentage-only suffix

- **GIVEN** stdin payload `{"context_window": {"used_percentage": 42}}`
- **WHEN** the statusline renders
- **THEN** the context segment renders with the percentage-only suffix (current behavior)
- **AND** no token-count text appears

### Requirement: Rate-limit countdown MUST source from CC payload

The 5H segment's `↻` countdown MUST derive from `rate_limits.five_hour.resets_at` when present.
The 7D segment MUST apply the same precedence: when `rate_limits.seven_day.resets_at` (and/or
`used_percentage`) is present on the payload, it MUST take precedence over the
agent-analytics-derived 7D value. When the CC field is absent, the 7D segment MAY continue to
fall back to agent-analytics data (current behavior).

#### Scenario: 7D countdown sourced from CC payload

- **GIVEN** stdin payload `{"rate_limits": {"seven_day": {"resets_at": <now + 86400 seconds>}}}`
- **WHEN** the statusline renders
- **THEN** the 7D segment's countdown is computed from the CC-supplied `resets_at`, not the
  agent-analytics value

#### Scenario: 7D falls back when CC field absent

- **GIVEN** a stdin payload without `rate_limits.seven_day`
- **WHEN** the statusline renders
- **THEN** the 7D segment uses agent-analytics-derived data (current behavior)

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

### Requirement: Cost segment MUST render when present and meaningful

When `cost.total_cost_usd` is a number ≥ 0.01, the statusline MUST render a cost segment formatted as `$X.XX` (2 decimal places) in the `DIM` color code. The segment MUST be placed between the project-name segment and the 5H rate-limit segment. When absent or below the 0.01 threshold, the segment MUST NOT render.

#### Scenario: Cost $0.12 renders in DIM

- **GIVEN** payload `{"cost": {"total_cost_usd": 0.12}}`
- **WHEN** the statusline renders
- **THEN** output contains `$0.12` styled with the `DIM` ANSI color
- **AND** the segment appears before the 5H segment

#### Scenario: Cost below threshold omits segment

- **GIVEN** payload `{"cost": {"total_cost_usd": 0.003}}`
- **WHEN** the statusline renders
- **THEN** no cost segment appears in output

### Requirement: Line-delta segment MUST render when non-zero

When both `cost.total_lines_added` and `cost.total_lines_removed` are numbers AND at least one is positive, the statusline MUST render a line-delta segment formatted as `+<added>/-<removed>` in the `DIM` color code. When both are zero or either is absent, the segment MUST NOT render.

#### Scenario: +10/-2 delta renders

- **GIVEN** payload `{"cost": {"total_lines_added": 10, "total_lines_removed": 2}}`
- **WHEN** the statusline renders
- **THEN** output contains `+10/-2` styled with `DIM`

#### Scenario: Both zero omits segment

- **GIVEN** payload `{"cost": {"total_lines_added": 0, "total_lines_removed": 0}}`
- **WHEN** the statusline renders
- **THEN** no line-delta segment appears

### Requirement: Output-style segment MUST render for non-default styles

When `output_style` is a string AND not equal to `"default"`, the statusline MUST render an 8-character truncation of the style name in `DIM`. The default style MUST render no segment to avoid clutter for the most common case.

#### Scenario: tts-summary style rendered abbreviated

- **GIVEN** payload `{"output_style": "tts-summary"}`
- **WHEN** the statusline renders
- **THEN** output contains a ≤ 8-character representation of the style (e.g. `tts-summ`)

#### Scenario: Default style omitted

- **GIVEN** payload `{"output_style": "default"}`
- **WHEN** the statusline renders
- **THEN** no style segment appears

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

### Requirement: Context-exceeds-200k marker

When `exceeds_200k_tokens` is `true`, the statusline MUST render a compact marker immediately
before the context bar segment. When `false` or absent, no marker renders.

#### Scenario: Marker renders when true

- **GIVEN** stdin payload `{"exceeds_200k_tokens": true}`
- **WHEN** the statusline renders
- **THEN** the marker appears immediately before the context bar segment

#### Scenario: No marker when false or absent

- **GIVEN** stdin payload `{"exceeds_200k_tokens": false}` or a payload omitting the field
- **WHEN** the statusline renders
- **THEN** no marker appears

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

### Requirement: Multi-line pulse pass-through MUST be preserved

The statusline MUST render an embedded newline in the cached `pulse` string (produced by cc's `roadmap-pulse --line`) as separate trailing rows — one per line — rather than collapsing or truncating it onto a single row. This formalizes existing pass-through behavior (`readFileSync(...).trim()` already preserves internal newlines) as a tested contract so a future refactor of the pulse-render path cannot silently regress it.

#### Scenario: Two-line pulse renders as two rows

- **GIVEN** `deps.pulse` is `"next: Merge Slot\nradar:stale"`
- **WHEN** the statusline renders
- **THEN** the output's final two lines are `next: Merge Slot` and `radar:stale`, in that order

#### Scenario: Single-line pulse still renders as one row (no regression)

- **GIVEN** `deps.pulse` is `"next: ship the thing"` (no embedded newline)
- **WHEN** the statusline renders
- **THEN** the output ends with exactly one additional row: `next: ship the thing`

### Requirement: Radar-derived pulse content MUST be gated to B&B projects

The statusline MUST classify the active project as B&B or non-B&B and MUST NOT render
radar-derived pulse content for non-B&B projects. Classification (`isBbProject`):

1. If `<projectDir>/.claude/project.toml` exists and declares an `org` key under `[project]`,
   that value is authoritative: `org = "bb"` means B&B, any other value means non-B&B. The read
   uses a minimal regex parse (no TOML dependency, same approach as the existing
   `getLocalAgentUrl` `agents.toml` parse) and MUST never throw.
2. Otherwise, the project code (resolved exactly as the existing project-name segment:
   `basename(workspace.project_dir)`, falling back to `deriveProjectCode(projectDir)`) is matched
   against the fallback allowlist `ws fb dc se tb sc ba bo es ew ic lu pp`. In the allowlist
   means B&B; otherwise non-B&B.

Application of the gate:

- For non-B&B projects, the `radar:stale` token MUST be stripped from the pulse counts row before
  rendering (exact token match within the comma-separated counts row; if the row becomes empty it
  is dropped entirely). All non-radar pulse content (openspec counts, `next:` rows) renders
  unchanged.
- The background pulse-refresh spawn in `getRoadmapPulse` MUST pass the gate result to the
  producer as environment variable `PULSE_RADAR` (`0` = non-B&B, `1` = B&B) so cc's
  `roadmap-pulse` can skip radar rungs at computation time and backfill `next:` from lower rungs.
  (Producer-side handling is a cc-repo follow-up; the variable name is reserved by this
  requirement.)
- For B&B projects, radar-derived content renders exactly as today.

#### Scenario: Non-B&B project hides the radar counts token

- **GIVEN** the project resolves to code `nx` (no `.claude/project.toml` `org` key, not in the allowlist)
- **AND** the cached pulse is `"next: ship the thing\n7o,radar:stale"`
- **WHEN** the statusline renders
- **THEN** the counts row renders as `7o`
- **AND** no `radar:stale` text appears anywhere in the output

#### Scenario: Allowlisted B&B project renders radar content unchanged

- **GIVEN** the project resolves to code `ws` with no `.claude/project.toml`
- **AND** the cached pulse counts row contains `radar:stale`
- **WHEN** the statusline renders
- **THEN** the `radar:stale` token renders exactly as today

#### Scenario: project.toml org key overrides the allowlist

- **GIVEN** a project whose code is NOT in the allowlist but whose `.claude/project.toml` declares `org = "bb"` under `[project]`
- **WHEN** the statusline classifies the project
- **THEN** the project is treated as B&B and radar content renders

#### Scenario: Refresh spawn carries the gate to the producer

- **GIVEN** a non-B&B project with a stale pulse cache
- **WHEN** `getRoadmapPulse` spawns the background refresh
- **THEN** the spawned process environment contains `PULSE_RADAR=0`
- **AND** for a B&B project it contains `PULSE_RADAR=1`

#### Scenario: Unreadable project.toml degrades to the allowlist without crashing

- **GIVEN** a project whose `.claude/project.toml` is unreadable or malformed
- **WHEN** the statusline classifies the project
- **THEN** classification falls back to the allowlist match
- **AND** no error is thrown and the statusline renders normally

### Requirement: Row-one model-effort token

The statusline MUST render a compact model-effort token in place of the current model
display-name segment (which renders only the version number via `shortenModel`). The token is
`<letter><suffix>` in the `DIM` color, in the same row-one position as the current model segment
(after the line-delta segment, before the output-style segment):

- Letter from the model family, derived from `model.id` substring match (`fable` → `F`, `opus` →
  `O`, `sonnet` → `S`, `haiku` → `H`, case-insensitive), falling back to the same match against
  `model.display_name`; an unrecognized family renders the first letter of `display_name`
  uppercased.
- Suffix from `effort.level`: `low` → `l`, `medium` → `m`, `high` → `h`, `xhigh` → `xh`, and
  `max` or `ultracode` → `u`. When `effort` is absent or the value is unrecognized, the letter
  renders alone.
- When no model field is present, no token renders (an effort level alone MUST NOT produce a
  token).

This requirement supersedes the standalone reasoning-effort tag proposed by
`update-statusline-cc-metadata`: the combined token is the only row-one rendering of
`effort.level`.

#### Scenario: Fable at max effort renders Fu

- **GIVEN** stdin payload `{"model": {"id": "claude-fable-5", "display_name": "Fable 5"}, "effort": {"level": "max"}}`
- **WHEN** the statusline renders
- **THEN** row one contains the token `Fu` in `DIM`
- **AND** no standalone `5` model segment appears

#### Scenario: Sonnet at xhigh effort renders Sxh

- **GIVEN** stdin payload `{"model": {"id": "claude-sonnet-4-6", "display_name": "Sonnet 4.6"}, "effort": {"level": "xhigh"}}`
- **WHEN** the statusline renders
- **THEN** row one contains the token `Sxh`

#### Scenario: Effort absent renders the model letter alone

- **GIVEN** stdin payload `{"model": {"id": "claude-opus-4-8", "display_name": "Opus 4.8"}}` with no `effort` field
- **WHEN** the statusline renders
- **THEN** row one contains the token `O` with no effort suffix

#### Scenario: Model absent renders no token

- **GIVEN** stdin payload `{"effort": {"level": "high"}}` with no `model` field
- **WHEN** the statusline renders
- **THEN** no model-effort token appears
- **AND** no error is thrown

#### Scenario: Unrecognized model family falls back to display_name initial

- **GIVEN** stdin payload `{"model": {"id": "claude-newmodel-1", "display_name": "Newmodel 1"}, "effort": {"level": "low"}}`
- **WHEN** the statusline renders
- **THEN** row one contains the token `Nl`


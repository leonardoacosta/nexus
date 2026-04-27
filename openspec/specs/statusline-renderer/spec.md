# statusline-renderer Specification

## Purpose
TBD - created by archiving change fix-nexus-status-cc-payload. Update Purpose after archive.
## Requirements
### Requirement: Statusline MUST consume the canonical CC payload

The `nexus-status` statusline binary (`apps/nexus-status/src/index.ts`) MUST declare a TypeScript input type matching the canonical CC statusline payload documented at [code.claude.com/docs/en/statusline](https://code.claude.com/docs/en/statusline). At minimum the type MUST include optional fields for `hook_event_name`, `session_id`, `transcript_path`, `cwd`, `model` (with `id` and `display_name`), `workspace` (with `current_dir` and `project_dir`), `version`, `output_style`, `cost` (with `total_cost_usd`, `total_duration_ms`, `total_api_duration_ms`, `total_lines_added`, `total_lines_removed`), `context_window` (with `used_percentage`, `used_tokens`, `max_tokens`), and `rate_limits.five_hour.resets_at`.

#### Scenario: Full payload accepted without error

- **GIVEN** the canonical 2026-04-24 CC payload is piped to `nexus-status` via stdin
- **WHEN** the binary parses the input
- **THEN** the parse MUST succeed without throwing
- **AND** all rendered segments that depend on payload fields MUST populate correctly

#### Scenario: Missing fields degrade gracefully

- **GIVEN** a payload with only `{model: {display_name: "Opus"}}` (all other fields absent)
- **WHEN** the binary renders
- **THEN** no error is thrown
- **AND** only the model-dependent segment populates
- **AND** the process exits 0

### Requirement: Context bar MUST render from used_percentage

When `context_window.used_percentage` is a number between 0 and 100 inclusive, the statusline MUST render a context bar segment. The rendered "remaining" percentage MUST be computed as `100 - used_percentage`. Color banding MUST apply as before: remaining > 40% = `CTX_HIGH` mint, 20–40% = `CTX_MED` orange, < 20% = `CTX_LOW` red. The legacy field name `remaining_percentage` MUST be removed from both the type declaration and any documentation comments in the source file.

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

### Requirement: Rate-limit countdown MUST source from CC payload

When `rate_limits.five_hour.resets_at` is a unix timestamp, the 5H segment's reset countdown (`↻`) MUST be computed as `resets_at - now` and formatted as `XhYm` / `Xm` / `Xd` as appropriate. When the field is absent, the segment MAY fall back to the existing agent-analytics-derived reset time. The statusline MUST visually distinguish these two sources only if the numbers diverge by more than 10% (the source is an implementation detail users don't need on screen).

#### Scenario: Countdown from CC resets_at

- **GIVEN** stdin payload `{"rate_limits": {"five_hour": {"resets_at": <now + 1800 seconds>}}}`
- **WHEN** the statusline renders
- **THEN** the 5H segment's `↻` countdown shows `30m` (or equivalent)

#### Scenario: Fallback to agent when CC field absent

- **GIVEN** a stdin payload without `rate_limits`
- **WHEN** the statusline renders
- **THEN** the 5H segment's `↻` countdown uses agent-analytics data (current behavior)
- **AND** no visible marker differentiates the source

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


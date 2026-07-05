# statusline-renderer — Spec Delta

## MODIFIED Requirements

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

### Requirement: Rate-limit segments MUST source from CC payload, not re-query agent

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

## ADDED Requirements

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

### Requirement: Reasoning-effort tag

When `effort.level` is present, the statusline MUST render it as a DIM-colored tag immediately
after the model segment (before the `output_style` segment). When `effort` is absent, no tag
renders.

#### Scenario: Effort tag renders

- **GIVEN** stdin payload `{"effort": {"level": "xhigh"}}`
- **WHEN** the statusline renders
- **THEN** a DIM `xhigh` tag appears immediately after the model segment

#### Scenario: No tag when effort absent

- **GIVEN** a stdin payload without an `effort` field
- **WHEN** the statusline renders
- **THEN** no effort tag appears

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

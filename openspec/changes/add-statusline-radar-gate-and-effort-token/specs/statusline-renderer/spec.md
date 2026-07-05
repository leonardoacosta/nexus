# statusline-renderer — Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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

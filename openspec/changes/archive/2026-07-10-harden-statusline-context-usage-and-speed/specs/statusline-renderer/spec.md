# statusline-renderer Specification (delta)

## ADDED Requirements

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

### Requirement: Statusline MUST prefer CC stdin usage over the OAuth Usage API

The `nexus-statusline` binary MUST read `rate_limits.five_hour.used_percentage` and
`rate_limits.seven_day.used_percentage` from the CC stdin payload when both are present, build the
5h/7d usage display from them, and skip the authenticated OAuth Usage-API fetch and credential
read for that render. When either window's `used_percentage` is absent from stdin, it MUST fall
back to the OAuth Usage-API path. The input type MUST declare `used_percentage` on both
`rate_limits.five_hour` and `rate_limits.seven_day`.

#### Scenario: Stdin usage present renders without a network call

- **WHEN** stdin carries `used_percentage` for both `five_hour` and `seven_day`
- **THEN** the 5H and 7D gauges render from the stdin values
- **AND** the OAuth Usage-API fetch and credential read are not performed for that render

#### Scenario: Stdin usage absent falls back to the OAuth Usage API

- **WHEN** stdin omits `used_percentage` for either usage window
- **THEN** the binary falls back to the OAuth Usage-API result to populate the gauges

### Requirement: Statusline MUST surface a live tokens-per-second estimate

The `nexus-statusline` binary MUST compute a heuristic throughput estimate from the growth of the
transcript file size between renders, using a per-session speed cache keyed by `session_id`. It
MUST stat (not read/parse) `transcript_path`. It MUST suppress the estimate when the elapsed
interval is stale, too short, or the byte delta is non-positive, and render a distinct
approximate-throughput segment only when a valid estimate exists. The path MUST be fail-soft.

#### Scenario: Byte growth within the window renders a throughput segment

- **WHEN** the transcript file has grown by a positive byte delta over an interval within the
  valid speed window since the last render
- **THEN** an approximate tokens-per-second segment renders on the statusline

#### Scenario: Stale or too-short interval renders no throughput segment

- **WHEN** the interval since the last recorded sample is stale (beyond the speed window) or
  shorter than the minimum delta, or the byte delta is non-positive
- **THEN** no throughput segment is rendered

### Requirement: Statusline gauge width MUST adapt to terminal width

The `nexus-statusline` binary MUST size its gauge bars from the terminal column count — read from
the `COLUMNS` environment variable, falling back to `process.stdout.columns` — bucketing to 10
cells at ≥100 columns, 6 cells at ≥60 columns, and 4 cells below that, defaulting to 10 cells when
the width is unknown. The bar's fill computation MUST scale with the resolved width.

#### Scenario: Wide terminal renders a 10-cell bar

- **WHEN** the terminal reports 100 or more columns
- **THEN** each gauge bar renders with 10 cells

#### Scenario: Narrow terminal renders a 4-cell bar

- **WHEN** the terminal reports fewer than 60 columns
- **THEN** each gauge bar renders with 4 cells

#### Scenario: Unknown width defaults to 10 cells

- **WHEN** neither `COLUMNS` nor `process.stdout.columns` yields a usable width
- **THEN** each gauge bar renders with the 10-cell default

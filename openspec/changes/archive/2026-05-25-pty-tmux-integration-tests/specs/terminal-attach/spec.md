# terminal-attach

## ADDED Requirements

### Requirement: TmuxPtySource Spawn Seam

`TmuxPtySource` SHALL accept an injectable spawn adapter so its tmux argv construction can be
unit-tested without a live tmux server. The adapter SHALL default to Bun's `spawn`/`spawnSync`,
producing byte-for-byte identical behavior in production.

#### Scenario: Default adapter preserves production behavior

- **WHEN** `TmuxPtySource` is constructed without an explicit spawn adapter
- **THEN** it uses `Bun.spawnSync` and `Bun.spawn` exactly as before — no argv, ordering, or
  lifecycle change versus the pre-seam implementation

#### Scenario: Injected adapter records argv

- **WHEN** a recording spawn adapter is injected and the source performs scrollback seed,
  geometry sample, pipe-pane setup, write, resize, and close
- **THEN** every tmux invocation is captured with its full argument vector for assertion, and
  no real tmux process is spawned

### Requirement: TmuxPtySource Argv Correctness

The argv `TmuxPtySource` constructs for each tmux operation SHALL be asserted by unit tests, so
a regression in any command's flags fails before it ships.

#### Scenario: Scrollback seed argv

- **WHEN** the source seeds scrollback at construction
- **THEN** it invokes `tmux capture-pane -p -S -<lines> -E - -t <target>`

#### Scenario: Geometry sample argv

- **WHEN** the source samples pane geometry
- **THEN** it invokes `tmux display-message -p -t <target> #{pane_width}x#{pane_height}` and
  parses the `<cols>x<rows>` response

#### Scenario: Literal write argv (no auto-Enter)

- **WHEN** `write()` is called with input bytes
- **THEN** it invokes `tmux send-keys -t <target> -l <text>` — the `-l` literal flag is present
  so the text is inserted without an implicit Enter

#### Scenario: Resize forces manual window-size once

- **WHEN** `resize(cols, rows)` is called for the first time on a source
- **THEN** the source reads the prior `window-size` option, sets it to `manual`, then invokes
  `tmux resize-window -t <target> -x <cols> -y <rows>`
- **AND WHEN** `resize` is called again on the same source, the prior `window-size` is NOT
  re-read or re-set (capture happens exactly once)

#### Scenario: Auto-restore reverts window-size

- **WHEN** `restoreWindowSize()` is called after a take-over resize
- **THEN** the source sets `window-size` back to the recorded prior value and clears the record;
  a never-resized source's restore is a no-op (no tmux invocation)

#### Scenario: Close detaches pipe and cleans up

- **WHEN** `close()` is called
- **THEN** it invokes `tmux pipe-pane -t <target>` (no command) to detach, kills the local
  reader child, and removes the temp FIFO directory

### Requirement: Real-Tmux Attach Round-Trip

A `hasTmux`-gated integration test SHALL exercise `TmuxPtySource` against a real tmux pane
running a deterministic TUI surrogate (NOT the real Claude TUI), validating the full attach
lifecycle end-to-end.

#### Scenario: Surrogate is deterministic

- **WHEN** the TUI-surrogate fixture runs in a tmux pane
- **THEN** its rendered output is fully controlled (bash/ANSI via `tput`/`printf`), so
  byte-level assertions are stable across runs

#### Scenario: Geometry reflects the real pane

- **WHEN** a `TmuxPtySource` attaches to the surrogate pane sized to a known geometry
- **THEN** `geometry()` returns the pane's actual `<cols>x<rows>` (not the 80x24 default)

#### Scenario: Scrollback captures real pane content byte-exact

- **WHEN** the surrogate prints a known marker line and a source attaches
- **THEN** the seeded scrollback contains that marker line exactly

#### Scenario: Raw input does not auto-submit

- **WHEN** raw bytes without a carriage return are written to the pane
- **THEN** the surrogate shows the typed characters but registers no line submission

#### Scenario: Carriage return submits

- **WHEN** a `0x0D` carriage return is written after input
- **THEN** the surrogate registers exactly one line submission

#### Scenario: Resize drives a new geometry

- **WHEN** `resize(cols, rows)` targets a new size
- **THEN** a subsequent `geometry()` reflects the new dimensions and the surrogate reflows to them

#### Scenario: Teardown restores and cleans up

- **WHEN** the pane is killed (or the source is closed)
- **THEN** the output stream completes, the temp FIFO directory is removed, and any forced
  `window-size manual` is reverted to its prior value

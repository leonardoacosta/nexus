## REMOVED Requirements

### Requirement: Context bar MUST render from used_percentage
Removed — the CTX gauge segment is being dropped entirely; model/git/usage information is
moving into cc-tmux's row 2 instead. The underlying spurious-zero-frame guard
(`context-guard.ts`) survives (see the separate "SHALL push its resolved context-window reading
to nx-agent" requirement, unchanged) since its output still feeds nx-agent independently of this
render-facing segment.

#### Scenario: CTX gauge no longer renders
- Given: a CC payload with a valid `context_window` object
- When: the statusline renders
- Then: no `CTX` gauge segment appears anywhere in the output

### Requirement: Rate-limit countdown MUST source from CC payload
Removed — the 5H/7D usage gauges are being dropped. `usage-cache.json`'s writer (nx-agent) and
its OTHER reader (cc-tmux's `usage.py`) are unaffected — only nexus-statusline's own reader/
render of this data is removed.

#### Scenario: 5H/7D gauges no longer render
- Given: a CC payload or polled cache with valid rate-limit data
- When: the statusline renders
- Then: no `5H`/`7D` gauge segment appears anywhere in the output

### Requirement: Cost segment MUST render when present and meaningful
Removed per the explicit segment-removal list.

#### Scenario: cost no longer renders
- Given: a CC payload with `cost.total_cost_usd` present and nonzero
- When: the statusline renders
- Then: no `$`-prefixed cost segment appears anywhere in the output

### Requirement: Line-delta segment MUST render when non-zero
Removed per the explicit segment-removal list.

#### Scenario: line deltas no longer render
- Given: a CC payload with nonzero `cost.total_lines_added`/`total_lines_removed`
- When: the statusline renders
- Then: no `+N/-M` segment appears anywhere in the output

### Requirement: Output-style segment MUST render for non-default styles
Removed per the explicit segment-removal list.

#### Scenario: output style no longer renders
- Given: a CC payload with a non-default `output_style.name`
- When: the statusline renders
- Then: no output-style tag appears anywhere in the output

### Requirement: Context-exceeds-200k marker
Removed — depends on the same context data as the removed CTX gauge; model/context information
moves to cc-tmux instead.

#### Scenario: 200k marker no longer renders
- Given: a CC payload with `exceeds_200k_tokens` true
- When: the statusline renders
- Then: no `200K+` marker appears anywhere in the output

### Requirement: Multi-line pulse pass-through MUST be preserved
Removed — the roadmap-pulse trailing line (`getRoadmapPulse`, distinct from the KEPT
`getRoadmapLine` — different producer, different cache file, confirmed by reading
`agent-lines.ts` before this decision) is being dropped per the explicit removal list.

#### Scenario: pulse trailing line no longer renders
- Given: a populated `roadmap-pulse.<code>.line` cache file
- When: the statusline renders
- Then: no pulse-derived trailing line appears in the output; the roadmap trailing line
  (`getRoadmapLine`, unaffected) still renders normally if its own data is present

### Requirement: Radar-derived pulse content MUST be gated to B&B projects
Removed — this requirement governs gating logic for the same pulse content removed above; with
the pulse line gone, the gate has nothing left to gate.

#### Scenario: no pulse gate needed
- Given: any project, B&B-fleet or not
- When: the statusline renders
- Then: no pulse-derived content or gate logic runs — the requirement and its implementation are
  both removed

### Requirement: Row-one model-effort token
Removed — the `M:<model><effort>` token (the label added by a prior session's if-bqw.3 fix) is
dropped; model identity moves to cc-tmux's row 2, which now colors the model letter directly
(see the sibling `installfest` proposal `cc-tmux-row2-model-color-usage-format`).

#### Scenario: model token no longer renders
- Given: a CC payload with `model` and `effort` present
- When: the statusline renders
- Then: no `M:`-prefixed token appears anywhere in the output

### Requirement: Statusline MUST prefer CC stdin usage over the OAuth Usage API
Removed — this requirement governs HOW 5H/7D data is resolved for rendering; with the 5H/7D
gauges themselves removed above, the resolution logic (`resolveUsage`/`buildStdinUsage`/
`polledUsageFromCache` in `usage.ts`) has no remaining consumer within this package. The
underlying `usage-cache.json` file, its writer, and cc-tmux's independent read of it are
UNAFFECTED (confirmed cross-process reader/writer contract in `packages/statusline-contract`).

#### Scenario: no usage resolution needed for rendering
- Given: any combination of stdin usage data and/or a polled usage cache
- When: the statusline renders
- Then: neither is consulted for rendering purposes (no 5H/7D segment exists to feed) — the
  cache file itself may still exist on disk, written and read by other processes

### Requirement: Statusline MUST surface a live tokens-per-second estimate
Removed per the explicit segment-removal list ("speeds").

#### Scenario: speed no longer renders
- Given: a transcript file with recent byte growth between two renders
- When: the statusline renders
- Then: no `≈Nt/s` segment appears anywhere in the output

### Requirement: Statusline gauge width MUST adapt to terminal width
Removed — this requirement governed bar-width adaptation for the CTX/5H/7D gauges, all three now
removed; no gauge segment remains among the kept set (`@domain`, project code, session clock,
worktree badge, roadmap line) to need width adaptation.

#### Scenario: no gauge-width logic needed
- Given: any terminal width
- When: the statusline renders
- Then: no gauge segment exists whose width would need adapting — the requirement and its
  implementation are both removed

## MODIFIED Requirements

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

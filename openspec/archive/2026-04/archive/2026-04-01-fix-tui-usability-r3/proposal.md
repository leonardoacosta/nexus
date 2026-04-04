# Proposal: TUI Usability Fixes Round 3

## Change ID
`fix-tui-usability-r3`

## Summary
Fix onboarding gaps and remaining polish: informative empty state, discoverable ? help hint,
graceful config fallback, approve guard on finalized specs, Tab from Detail, stream placeholder
fix, scroll height fix, and Shift-A cleanup.

## Context
- Extends: `crates/nexus-tui/src/screens/dashboard.rs`, `screens/health.rs`, `screens/stream.rs`,
  `screens/specs.rs`, `screens/detail.rs`, `keys.rs`, `app.rs`, `main.rs`, `ui_helpers.rs`
- Related: `fix-tui-usability` (round 1), `fix-tui-usability-r2` (round 2)

## Motivation
Round 3 audit found that the biggest remaining gap is onboarding — the TUI assumes users already
know what Nexus is. Empty state gives no guidance, ? help is undiscoverable, config failure
crashes. Additionally, approve/reject is offered on already-finalized specs, Tab doesn't work on
Detail, and stream scroll uses hardcoded height.

## Requirements
### Req-1: Informative empty state
Empty Dashboard MUST show what Nexus is, how to start, and hint at ? for help.

### Req-2: Discoverable ? help
All title bars MUST include `?` in their key hints.

### Req-3: Graceful config fallback
Missing/malformed agents.toml MUST show a helpful error with config path and example, not crash.

### Req-4: Approve guard on finalized specs
Approve/reject MUST be disabled for specs already in approved/applied/archived/rejected status.

### Req-5: Tab from Detail
Tab/Shift-Tab MUST work from Detail screen to cycle to next tab screen.

### Req-6: Stream placeholder mentions i
Placeholder MUST say "press i to type" when not in input mode.

### Req-7: Fix hardcoded scroll heights
scroll_down and toggle_block_at_scroll MUST use terminal height, not hardcoded 20.

### Req-8: Remove misleading Shift-A message
Shift-A MUST be silently ignored instead of showing a confusing correction message.

## Scope
- **IN**: Empty state, ? hint, config fallback, approve guard, Tab on Detail, placeholder, scroll height, Shift-A
- **OUT**: Stream tab caching (N16), scratchpad cursor (N6), title bar responsive elision (N5), status bar unification (N23)

## Impact
| Area | Change |
|------|--------|
| dashboard.rs | Empty state text, ? in hints |
| health.rs | ? in hints, empty state guidance |
| projects.rs | ? in hints |
| specs.rs | ? in hints, approve guard on status |
| detail.rs | ? in hints |
| stream.rs | ? in hints, placeholder text, scroll height fix |
| keys.rs | Tab on Detail, approve guard, Shift-A removal, scroll height |
| main.rs | Config fallback |

## Risks
| Risk | Mitigation |
|------|-----------|
| Config fallback allows running with no agents | Shows warning, TUI renders empty but functional |

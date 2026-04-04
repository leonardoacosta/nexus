# Proposal: TUI Usability Fixes

## Change ID
`fix-tui-usability`

## Summary
Fix 13 usability issues across all TUI screens — key hint discoverability, approve confirmation,
palette navigation, help overlay, disconnected agent handling, and visual consistency.

## Context
- Extends: `crates/nexus-tui/src/keys.rs`, `screens/dashboard.rs`, `screens/health.rs`,
  `screens/projects.rs`, `screens/specs.rs`, `screens/stream.rs`, `app.rs`, `main.rs`
- Related: TUI usability audit (this session), `tui-analytics-wiring` spec (just shipped)

## Motivation
A usability audit found 13 issues that make the TUI unintuitive for first-time users. Key actions
(stream attach, input mode, spec approval) are hidden from key hints. The approve/reject actions
fire without confirmation. The palette returns to Dashboard instead of the previous screen.
Disconnected agent sessions vanish silently. Key `a` and `n` do different things on different
screens with no documentation.

## Requirements
### Req-1: Key hint discoverability
All primary actions on each screen MUST be visible in the title bar key hints. Hidden but important
bindings (`a: attach`, `i: input`, `n: new/notifications`) must be surfaced.

### Req-2: Approve/reject confirmation gate
Spec approval and rejection MUST require a two-step confirmation: first press shows "press again
to confirm" in the status bar, second press fires the action.

### Req-3: Palette returns to previous screen
Closing the command palette MUST return to the screen the user was on before opening it, not
hardcoded Dashboard.

### Req-4: Help overlay
Pressing `?` on any screen MUST show a help overlay listing all keybindings for the current screen.

### Req-5: Disconnected agent session visibility
Sessions from disconnected agents MUST remain visible on Dashboard in a dimmed state with a
"(disconnected)" badge, not silently removed.

### Req-6: Key consistency
Remap `a` on Specs detail to a different key (e.g., `Enter` or `A`) to avoid collision with
`a` = attach used everywhere else. Document `n` behavior per screen in hints.

### Req-7: Visual polish
Fix "ST" column header to "STATUS", expand verbosity labels from single-letter to 3-char,
add scrollbar to Projects table, use terminal height for PageUp/Down instead of hardcoded 20,
delete orphaned tmp files.

## Scope
- **IN**: Key hints, confirmation gate, palette fix, help overlay, disconnected visibility,
  key remapping, column headers, verbosity labels, scrollbar, page size, tmp cleanup
- **OUT**: New screens, layout restructuring, color scheme changes, status bar unification

## Impact
| Area | Change |
|------|--------|
| keys.rs | Approve confirmation state, key remapping, help toggle |
| dashboard.rs | Key hints update, disconnected session rendering, "STATUS" header |
| health.rs | Key hints update |
| projects.rs | Key hints update, scrollbar |
| specs.rs | Key hints update, approve key remap, confirmation UX |
| stream.rs | Key hints update (`i: input`), verbosity labels, dynamic page size |
| app.rs | previous_screen field, help overlay state, confirm state, disconnected filter |
| main.rs | Help overlay rendering |

## Risks
| Risk | Mitigation |
|------|-----------|
| Confirmation gate slows power users | Single extra keypress — muscle memory adapts quickly |
| Help overlay adds render complexity | Simple text block, no interactive elements |
| Disconnected sessions clutter Dashboard | Dimmed + grouped at bottom, visually distinct |

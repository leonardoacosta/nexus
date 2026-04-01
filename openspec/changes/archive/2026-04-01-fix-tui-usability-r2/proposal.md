# Proposal: TUI Usability Fixes Round 2

## Change ID
`fix-tui-usability-r2`

## Summary
Fix 8 remaining usability issues from re-audit: stream close navigation, disconnected session
guard, help overlay accuracy, confirm cancellation feedback, session type labels, orphaned tmp
files, and `/` palette documentation.

## Context
- Extends: `crates/nexus-tui/src/app.rs`, `keys.rs`, `ui_helpers.rs`, `screens/dashboard.rs`,
  `screens/stream.rs`, `theme.rs`
- Related: `fix-tui-usability` spec (round 1, just shipped), `tui-usability` spec

## Motivation
Round 1 fixed the 13 critical/high/medium issues. Re-audit verified all fixes landed but found
8 new issues — 2 medium (stream close navigation, disconnected guard) and 6 low (help accuracy,
confirm feedback, type labels, tmp files, documentation). These are polish items that complete
the usability pass.

## Requirements
### Req-1: Stream close returns to previous screen
`close_stream_attach()` MUST use `previous_screen` instead of hardcoded Dashboard.

### Req-2: Disconnected session guard
Pressing attach or detail on a disconnected session MUST show a status message instead of
silently hanging.

### Req-3: Help overlay accuracy
Help text MUST match actual keybindings. Detail screen needs its own help section. Specs help
must distinguish list vs detail mode.

### Req-4: Confirm cancellation feedback
When a pending approve confirmation is overwritten by reject (or vice versa), show "approval
cancelled" message before the new confirmation prompt.

### Req-5: Session type labels expanded
Expand `[M]`/`[A]` to `[MNG]`/`[ADH]` for consistency with verbosity label expansion.

### Req-6: Orphaned tmp files cleanup
Delete all `tmp.*.rs` files in `crates/nexus-core/src/`.

### Req-7: Document `/` as palette shortcut
Add `/` alongside `:` in help overlay and title bar hints where applicable.

## Scope
- **IN**: N1-N8 from re-audit, tmp file cleanup
- **OUT**: Title bar responsive elision (N5), notification panel help (N9), palette j/k (N11)

## Impact
| Area | Change |
|------|--------|
| app.rs | close_stream_attach uses previous_screen, confirm cancellation message |
| keys.rs | Disconnected session guard before attach/detail |
| ui_helpers.rs | Help overlay text updates for all screens |
| theme.rs | Session type indicator expansion |
| dashboard.rs | Add `/` to hints |
| nexus-core/src/ | Delete orphaned tmp files |

## Risks
| Risk | Mitigation |
|------|-----------|
| Blocking attach on disconnected sessions is too aggressive | Show warning but don't block — user can still try |

# Proposal: Fix palette search j/k key interception

## Change ID
`fix-palette-jk-input`

## Summary
Remove vim-style j/k navigation from the palette input handler so users can type those characters in search queries.

## Context
- Extends: `crates/nexus-tui/src/main.rs` — `handle_palette_key` function (line 1263)
- Related: none (no prior specs)

## Motivation
In palette input mode, `KeyCode::Char('j')` and `KeyCode::Char('k')` are matched before the generic `KeyCode::Char(c)` arm. Pressing 'j' navigates down instead of inserting the character; pressing 'k' is silently swallowed (the arm matches but an inner guard checks for `KeyCode::Up` only). Any palette query containing 'j' or 'k' is impossible to type, breaking search for common words like "project", "dark", "check", etc.

## Requirements
### Req-1: Arrow-only navigation in palette input
In palette input mode, only `KeyCode::Down` and `KeyCode::Up` SHALL navigate the result list. `Char('j')` and `Char('k')` SHALL be handled by the text input arm like any other character.

## Scope
- **IN**: `handle_palette_key` match arms for j/k/Up/Down
- **OUT**: Vim-style j/k navigation in other screens (Dashboard, Health, Projects) — those remain unchanged

## Impact
| Area | Change |
|------|--------|
| `crates/nexus-tui/src/main.rs` | Remove `Char('j')` / `Char('k')` from palette navigation arms |

## Risks
| Risk | Mitigation |
|------|-----------|
| Users relying on j/k in palette | Arrow keys still work; palette is a text input, not a vim buffer |

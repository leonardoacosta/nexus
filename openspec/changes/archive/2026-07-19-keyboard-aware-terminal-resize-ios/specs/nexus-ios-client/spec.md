## ADDED Requirements

### Requirement: The iOS Attach terminal SHALL remain visible above the keyboard

When the system keyboard is shown during a live Attach session, the terminal view SHALL resize
so its current cursor/prompt line remains visible above the keyboard, instead of the keyboard
overlaying the bottom of a full-bleed terminal frame. The resize SHALL reuse the existing
take-over resize path (`sizeChanged` -> `pushResize` -> `POST /commands/resize`) that device
rotation already drives — no new backend surface. The existing scroll lock
(`view.isScrollEnabled = false`, bd:mx-rkir.11) SHALL remain in effect at all times; this
requirement SHALL NOT re-enable user-drag scrolling into local scrollback.

#### Scenario: Keyboard shows during an attached session
- **GIVEN** a live Attach session is showing tmux pane output
- **WHEN** the user taps the terminal to type and the system keyboard appears
- **THEN** the terminal view resizes so the current cursor/prompt line is visible above the
  keyboard
- **AND** the resize is pushed to the agent via the existing `POST /commands/resize` take-over
  path

#### Scenario: Keyboard hides
- **GIVEN** the terminal view is resized to accommodate a visible keyboard
- **WHEN** the keyboard is dismissed
- **THEN** the terminal view resizes back to its full available height via the same resize path

#### Scenario: Scroll lock preserved
- **GIVEN** the keyboard-aware resize behavior is active
- **WHEN** the user attempts to drag/scroll the terminal view
- **THEN** the view does not scroll into local scrollback (`isScrollEnabled` remains `false`)

#### Scenario: Rapid keyboard toggling is debounced
- **GIVEN** the user rapidly dismisses and re-shows the keyboard (e.g. switching between typing
  and glancing at output)
- **WHEN** multiple keyboard show/hide notifications fire in quick succession
- **THEN** the terminal issues a debounced resize call, not one `POST /commands/resize` call per
  notification

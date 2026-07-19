## ADDED Requirements

### Requirement: The iOS Attach terminal SHALL allow scroll only for non-alt-screen sessions with the keyboard down

The terminal view's user-drag scroll SHALL be enabled if and only if BOTH: the system keyboard is
not currently shown, AND the session is not currently in tmux alternate-screen mode (`SwiftTerm`'s
`Terminal.isCurrentBufferAlternate == false`). All other scroll-lock properties (bounce,
scroll indicators, content-inset adjustment) SHALL toggle in lockstep with scroll enablement —
never independently. This requirement SHALL NOT alter the underlying garble-prevention rationale
(bd:mx-rkir.11): alt-screen sessions remain non-scrollable at all times regardless of keyboard
state.

#### Scenario: Plain shell, keyboard down — scroll enabled
- **GIVEN** a live Attach session showing a plain (non-alt-screen) shell
- **WHEN** the system keyboard is not shown
- **THEN** the user can drag-scroll the terminal to review recent output

#### Scenario: Alt-screen session, keyboard down — scroll stays locked
- **GIVEN** a live Attach session currently in alt-screen mode (e.g. the Claude Code TUI)
- **WHEN** the system keyboard is not shown
- **THEN** the terminal remains non-scrollable — no user-drag scroll, no bounce, no scroll
  indicators

#### Scenario: Keyboard shows during a scrollable (plain-shell) session
- **GIVEN** the terminal is currently scrollable (plain shell, keyboard down)
- **WHEN** the system keyboard is shown
- **THEN** scroll is disabled and the view snaps back to the live/bottom position if it was
  scrolled away from it

#### Scenario: Session transitions into alt-screen mode while scrollable
- **GIVEN** the terminal is currently scrollable (plain shell, keyboard down)
- **WHEN** the session's output enters alt-screen mode (e.g. the user runs `less` or `vim`)
- **THEN** scroll is disabled and the view snaps back to the live position if it was scrolled
  away from it

#### Scenario: Session exits alt-screen mode with the keyboard already down
- **GIVEN** an alt-screen session (non-scrollable) with the keyboard down
- **WHEN** the session's output exits alt-screen mode back to a plain shell
- **THEN** scroll becomes enabled without requiring a reattach or keyboard toggle

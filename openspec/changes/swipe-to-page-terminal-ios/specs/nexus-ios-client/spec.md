## ADDED Requirements

### Requirement: The iOS Attach terminal SHALL support swipe-to-page navigation

The terminal view SHALL recognize a vertical swipe gesture, alongside the existing tap-to-refocus
gesture, and translate it into a call to SwiftTerm's own `TerminalView.pageUp()` (swipe down) or
`TerminalView.pageDown()` (swipe up). No new escape-sequence encoding or alt-screen detection
SHALL be implemented — these methods already dispatch correctly (send the PgUp/PgDn escape
sequence when the session is in alt-screen mode; scroll the local buffer otherwise).

#### Scenario: Swipe down reveals older content
- **GIVEN** a live Attach session (any session type)
- **WHEN** the user swipes down on the terminal view
- **THEN** `pageUp()` is called, revealing older content (local scroll for a plain shell, or the
  PgUp escape sequence sent to the remote app for an alt-screen session)

#### Scenario: Swipe up reveals newer content
- **GIVEN** a live Attach session (any session type)
- **WHEN** the user swipes up on the terminal view
- **THEN** `pageDown()` is called, revealing newer content (local scroll for a plain shell, or
  the PgDn escape sequence sent to the remote app for an alt-screen session)

#### Scenario: Existing tap-to-refocus is unaffected
- **GIVEN** the new swipe gesture recognizer is present
- **WHEN** the user taps the terminal (not swipes)
- **THEN** the existing tap-to-refocus behavior (`handleFocusTap`) still fires correctly

# tui-usability Specification

## Purpose
TBD - created by archiving change fix-tui-usability. Update Purpose after archive.
## Requirements
### Requirement: All primary actions MUST be visible in screen title bar hints
Each screen's title bar MUST list the key bindings for every primary action available on that screen.

#### Scenario: Dashboard shows attach hint
Given the user is on the Dashboard screen
When the title bar renders
Then it includes "a: attach" alongside existing hints

#### Scenario: Stream shows input hint
Given the user is in StreamAttach view
When the title bar renders
Then it includes "i: input" alongside existing hints

### Requirement: Spec approve/reject MUST require two-step confirmation
Pressing the approve or reject key once MUST show a confirmation prompt in the status bar.
Only the second press within 3 seconds fires the HTTP action.

#### Scenario: First press shows confirmation
Given the user is viewing a spec detail with status "read"
When the user presses the approve key
Then the status bar shows "Press again to confirm approval" and no HTTP request is sent

#### Scenario: Second press within timeout fires action
Given the confirmation prompt is showing
When the user presses the approve key again within 3 seconds
Then the approve POST is sent and the spec status updates

#### Scenario: Timeout clears confirmation
Given the confirmation prompt is showing
When 3 seconds elapse without a second press
Then the confirmation state is cleared and the status bar returns to normal

### Requirement: Command palette MUST return to previous screen on close
Closing the palette MUST navigate back to the screen the user was on when they opened it.

#### Scenario: Palette opened from Projects
Given the user is on the Projects screen and presses ":"
When the palette opens then closes (Esc or selection)
Then the user returns to the Projects screen, not Dashboard

### Requirement: Pressing ? MUST show a help overlay for the current screen
A help overlay MUST render over the current screen listing all keybindings grouped by action.

#### Scenario: Help overlay on Dashboard
Given the user is on Dashboard
When the user presses "?"
Then a centered overlay shows all Dashboard keybindings
And pressing "?" or Esc closes the overlay

### Requirement: Disconnected agent sessions MUST remain visible on Dashboard
Sessions from disconnected agents MUST appear dimmed with a "(disconnected)" badge rather than
being removed from the session list.

#### Scenario: Agent disconnects mid-session
Given omarchy has 3 sessions and macbook has 2 sessions visible
When macbook agent disconnects
Then macbook's 2 sessions remain on Dashboard, dimmed, with "(disconnected)" badge

### Requirement: Approve key MUST NOT collide with attach key
The spec approval action MUST use a different key than "a" to avoid collision with the
stream attach action used on Dashboard and Detail screens.

#### Scenario: Enter approves in spec detail
Given the user is viewing a spec detail
When the user presses Enter (with confirmation)
Then the spec is approved (not "a" which means attach elsewhere)


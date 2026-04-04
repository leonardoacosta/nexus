## ADDED Requirements

### Requirement: Code Block Clipboard
The stream attach view SHALL allow users to copy code block content to the system clipboard.

#### Scenario: Yank code block under cursor
- **WHEN** the cursor is positioned within a fenced code block
- **AND** the user presses `y`
- **THEN** the code content (excluding fence markers) is copied to clipboard via OSC 52
- **AND** a confirmation notification appears in the status bar

#### Scenario: No code block at cursor
- **WHEN** the cursor is not within a code block
- **AND** the user presses `y`
- **THEN** nothing happens (no error, no notification)

### Requirement: Thinking Block Collapse
Extended thinking and reasoning blocks in assistant output SHALL render as collapsible sections,
defaulting to collapsed.

#### Scenario: Thinking block renders collapsed
- **WHEN** assistant output contains a thinking/reasoning block
- **THEN** it renders as a collapsed section with header "── thinking (N lines) ──"
- **AND** the full content is hidden by default

#### Scenario: Expand thinking block
- **WHEN** the user presses Enter on a collapsed thinking block
- **THEN** the full thinking content expands inline
- **AND** pressing Enter again collapses it

### Requirement: Stream Search
The stream attach view SHALL support searching through stream history with incremental
highlighting and match navigation.

#### Scenario: Open search
- **WHEN** the user presses `/` in stream attach normal mode
- **THEN** a search input overlay appears at the bottom of the stream view

#### Scenario: Incremental search highlighting
- **WHEN** the user types a search query
- **THEN** all matching text in the stream is highlighted with yellow background
- **AND** the match count is shown in the search overlay

#### Scenario: Navigate matches
- **WHEN** search is active and the user presses `n`
- **THEN** the view scrolls to the next match
- **AND** `N` scrolls to the previous match

### Requirement: Quick Session Tabs
The stream attach view SHALL support switching between recently streamed sessions via
numeric keys without returning to the dashboard.

#### Scenario: Switch session via tab key
- **WHEN** sessions for projects oo, nx, nv have been streamed in this TUI session
- **AND** the user presses `2` while attached to oo
- **THEN** the view switches to the nx session stream
- **AND** scroll position and buffer of the oo session are preserved

#### Scenario: Tab indicators in title bar
- **WHEN** multiple sessions have been streamed
- **THEN** the title bar shows tab indicators like `[1:oo] [2:nx] [3:nv]`
- **AND** the active tab is highlighted

### Requirement: Inline Diff Rendering
Tool results containing diff-like output SHALL render with colored syntax for
additions and removals.

#### Scenario: Diff lines colored
- **WHEN** a tool result contains lines starting with `+` or `-`
- **THEN** `+` lines render in green foreground
- **AND** `-` lines render in red foreground
- **AND** context lines render in dim text

## ADDED Requirements

### Requirement: Collapsible Tool Output

The stream view SHALL collapse tool result output that exceeds 5 lines into a single summary header line. The user SHALL be able to expand and collapse these blocks using the Enter key.

#### Scenario: Tool result exceeds collapse threshold

- **WHEN** a `ToolResult` event is received with `output_preview` containing more than 5 lines
- **THEN** the stream view SHALL render a single collapsed header line instead of the full output
- **AND** the header format SHALL be `  {icon} {tool_name} [+{N} lines] [Enter] to expand` where `{icon}` is the success/failure indicator, and `{N}` is the total line count of the output

#### Scenario: Tool result within threshold

- **WHEN** a `ToolResult` event is received with `output_preview` containing 5 or fewer lines
- **THEN** the stream view SHALL render the output inline as individual text lines (existing behavior)

#### Scenario: Expand collapsed block

- **WHEN** the user presses Enter in Normal mode while a collapsed `CollapsibleBlock` is visible at the current scroll position
- **THEN** the block SHALL expand to show the header line followed by all contained output lines
- **AND** if auto-scroll is enabled, the scroll position SHALL adjust to keep the bottom of the view anchored

#### Scenario: Collapse expanded block

- **WHEN** the user presses Enter in Normal mode while an expanded `CollapsibleBlock` is visible at the current scroll position
- **THEN** the block SHALL collapse back to a single header line
- **AND** if auto-scroll is enabled, the scroll position SHALL adjust to keep the bottom of the view anchored

### Requirement: StreamLine Line Model

The stream view SHALL use a `StreamLine` enum as its line model instead of plain `String` values. This enum SHALL support both plain text lines and collapsible blocks.

#### Scenario: StreamLine enum variants

- **WHEN** the stream view stores or renders lines
- **THEN** it SHALL use `StreamLine::Text(String)` for plain text lines
- **AND** `StreamLine::CollapsibleBlock { header: String, lines: Vec<String>, expanded: bool }` for collapsible tool output

#### Scenario: Existing text rendering unchanged

- **WHEN** a `StreamLine::Text` variant is rendered
- **THEN** the visual output SHALL be identical to the current plain-string rendering

### Requirement: Auto-Scroll Preservation on Expand

The stream view SHALL preserve the user's scroll context when expanding or collapsing blocks. Expanding a block adds lines below the header; collapsing removes them.

#### Scenario: Expand with auto-scroll enabled

- **WHEN** a block is expanded while auto-scroll is enabled
- **THEN** the scroll offset SHALL update so the bottom of the view remains anchored to the latest content

#### Scenario: Expand with auto-scroll disabled

- **WHEN** a block is expanded while auto-scroll is disabled (user has scrolled up)
- **THEN** the scroll offset SHALL remain unchanged so the user's current viewport does not jump

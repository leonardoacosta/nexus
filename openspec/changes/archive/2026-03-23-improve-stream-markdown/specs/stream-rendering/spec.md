## ADDED Requirements

### Requirement: Markdown Rendering for Assistant Text
The stream attach view SHALL render assistant text as formatted markdown, including headers,
bold, italic, inline code, code blocks, tables, lists, and horizontal rules.

#### Scenario: Headers render with style
- **WHEN** assistant text contains `## Section Title`
- **THEN** the header renders in bold with `SECONDARY` color
- **AND** the `##` prefix is not shown as literal text

#### Scenario: Code blocks render with highlighting
- **WHEN** assistant text contains a fenced code block with a language tag
- **THEN** the code block renders with a `SURFACE` background
- **AND** syntax highlighting is applied based on the language tag

#### Scenario: Tables render with alignment
- **WHEN** assistant text contains a markdown table
- **THEN** the table renders with box-drawing characters
- **AND** columns are aligned per the table's alignment markers

#### Scenario: Inline formatting renders correctly
- **WHEN** assistant text contains `**bold**`, `*italic*`, or `` `inline code` ``
- **THEN** bold renders as bold white, italic renders as italic, inline code renders with dim background

### Requirement: Streaming Markdown Stability
The markdown renderer SHALL handle incomplete markdown constructs during streaming without
visual artifacts or layout jumps.

#### Scenario: Partial code fence during streaming
- **WHEN** a code fence is opened (```) but not yet closed during streaming
- **THEN** accumulated lines render as preformatted text
- **AND** when the closing fence arrives, the full block re-renders with syntax highlighting

#### Scenario: Paragraph batching
- **WHEN** assistant text streams character-by-character
- **THEN** markdown rendering occurs at paragraph boundaries (double newline or flush)
- **AND** individual characters do not trigger full markdown re-parse

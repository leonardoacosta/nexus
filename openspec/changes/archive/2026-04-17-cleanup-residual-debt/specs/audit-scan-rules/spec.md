# audit-scan-rules Specification

## ADDED Requirements

### Requirement: A12 requires code-syntax signal to flag commented-out code
The A12 rule SHALL flag a comment only when the same line contains at least one code-syntax signal: `=` (assignment), `()` (call parens), `;` (statement terminator), or `{` (block opener). A comment that begins with a keyword but contains only natural-language text SHALL NOT be flagged.

#### Scenario: Commented-out variable declaration is flagged
- **GIVEN** a source file contains `// const x = 1;` (has `=` and `;`)
- **WHEN** audit-scan runs
- **THEN** an A12 finding SHALL be emitted for that line

#### Scenario: Commented-out function call is flagged
- **GIVEN** a source file contains `// handleClick();` (has `()` and `;`)
- **WHEN** audit-scan runs
- **THEN** an A12 finding SHALL be emitted for that line

#### Scenario: Commented-out return statement is flagged
- **GIVEN** a source file contains `// return result;`
- **WHEN** audit-scan runs
- **THEN** an A12 finding SHALL be emitted for that line

#### Scenario: English prose with no code syntax is NOT flagged
- **GIVEN** a source file contains `// return \`undefined\` so the chain short-circuits gracefully without`
- **WHEN** audit-scan runs
- **THEN** no A12 finding SHALL be emitted for that line

#### Scenario: Edge-case English prose containing parens is handled by comment rephrase
- **GIVEN** a source file originally contained `// if it needs to send a response (commands). For events,` (has `()` despite being English prose)
- **WHEN** the comment is rephrased to remove the confusing parens (e.g., `// if it needs to send a response for commands; for events,`)
- **THEN** no A12 finding SHALL be emitted
- **AND** the rephrase is documented in the implementation so future contributors understand why

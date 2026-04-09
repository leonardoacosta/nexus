# Spec: split-render-stream

## MODIFIED Requirements

### Requirement: render_stream decomposed into widget builders
The `render_stream` function in `crates/nexus-tui/src/screens/stream.rs` (~650 lines) MUST be split into a directory module (`screens/stream/`) with the coordinator in `mod.rs` and widget builders in separate files (header.rs, content.rs, status.rs). Each builder handles one logical section of the stream layout.

#### Scenario: render_stream delegates to widget builders
- **GIVEN** the stream module exists at `crates/nexus-tui/src/screens/stream/mod.rs`
- **WHEN** `render_stream` is called
- **THEN** it delegates to at least 3 widget builder functions, and no single function exceeds 200 lines

#### Scenario: Stream screen renders identically
- **GIVEN** the decomposition is complete
- **WHEN** running the TUI and viewing the stream screen
- **THEN** the visual output is identical to the pre-refactor state — no layout or content changes

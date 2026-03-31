## MODIFIED Requirements

### Requirement: Platform-Gated IMessageReaderService
The `imessage_reader` module SHALL only compile on macOS targets, and its `rusqlite` dependency SHALL be optional behind a `macos` feature flag.

#### Scenario: Linux build excludes imessage_reader
- **GIVEN** a Linux build target
- **WHEN** `cargo build -p nexus-agent` is run
- **THEN** the `imessage_reader` module is not compiled
- **AND** `rusqlite` is not linked

#### Scenario: macOS build includes imessage_reader
- **GIVEN** a macOS build target
- **WHEN** `cargo build -p nexus-agent` is run
- **THEN** the `imessage_reader` module compiles normally
- **AND** `rusqlite` is linked via the `macos` feature flag

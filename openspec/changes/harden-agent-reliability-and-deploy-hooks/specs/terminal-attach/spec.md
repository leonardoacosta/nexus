## ADDED Requirements

### Requirement: PTY viewer attach handshake SHALL establish terminal geometry before feeding output bytes

The Mac dashboard's PTY viewer MUST NOT feed streamed PTY bytes to the VT emulator (SwiftTerm)
before the initial `resize(cols, rows)` geometry frame has been applied to that emulator
instance, eliminating the attach-handshake race that produces garbled/jumbled output when bytes
arrive before geometry is known.

#### Scenario: Bytes arriving before the resize frame are buffered, not fed raw

- **GIVEN** a PTY viewer attaches to a session and the agent begins streaming raw bytes
  immediately
- **WHEN** the first output bytes arrive before the initial `resize(cols, rows)` frame has been
  processed
- **THEN** those bytes are buffered rather than fed directly to the VT emulator
- **AND** once the resize frame is applied, the buffered bytes are flushed to the emulator in
  original order
- **AND** the rendered output is not garbled

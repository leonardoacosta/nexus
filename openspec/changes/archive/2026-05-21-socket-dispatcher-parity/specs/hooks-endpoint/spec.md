## MODIFIED Requirements

### Requirement: AF_UNIX socket dispatcher SHALL match POST /hooks behavior identically

For every supported hook event type, the AF_UNIX socket dispatcher (`services/socket-server/dispatcher.ts`) SHALL produce byte-identical outcomes to the HTTP `POST /hooks` route. This includes: session_events row content, lifecycle bus envelope emission, throttle layer integration (500ms coalesce for tool_use_*), credentialFingerprint binding, schema-drift detector invocation (P2.1), git-project resolver invocation (P2.2).

#### Scenario: same payload via both paths produces identical session_events row
- **GIVEN** an identical hook payload P
- **WHEN** P is sent via both POST /hooks and the AF_UNIX socket
- **THEN** both result in `session_events` rows with byte-identical `metadata` JSON

#### Scenario: throttle behavior matches across paths
- **GIVEN** 5 tool_use_end events within 500ms via the socket path
- **WHEN** the throttle window flushes
- **THEN** exactly one envelope is emitted with `count=5` — identical to HTTP path behavior

#### Scenario: credential fingerprint binding works
- **GIVEN** a payload with a credentialFingerprint field via socket
- **WHEN** the dispatcher processes it
- **THEN** the resulting session row has the same `credentialFingerprint` value the HTTP path would produce

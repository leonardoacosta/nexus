## MODIFIED Requirements

### Requirement: Agent Internal Code Quality
The nexus-agent crate SHALL maintain async-correct I/O patterns, avoid dead code, share expensive resources, and handle serialization errors gracefully.

#### Scenario: No dead modules in receiver service
- **WHEN** the receiver service module tree is inspected
- **THEN** there SHALL be no unused module files or unreachable function definitions

#### Scenario: No dead struct fields on ReceiverService
- **WHEN** the ReceiverService struct is inspected
- **THEN** every field SHALL be read by at least one method on the struct

#### Scenario: Async handlers use non-blocking I/O
- **WHEN** an HTTP or gRPC handler performs filesystem reads
- **THEN** it SHALL use `tokio::fs` or `spawn_blocking` instead of `std::fs`

#### Scenario: Shared HTTP client across services
- **WHEN** any service or handler needs to make outbound HTTP requests
- **THEN** it SHALL use the shared `reqwest::Client` from AppState or its constructor rather than creating a new client per request

#### Scenario: No self-HTTP loopback
- **WHEN** an in-process function needs data from another handler's domain
- **THEN** it SHALL call the domain logic directly rather than making an HTTP request to itself

#### Scenario: Fallible serialization handled gracefully
- **WHEN** `serde_json::to_value()` is called in an HTTP handler
- **THEN** failures SHALL return an appropriate HTTP error status rather than panicking via `.unwrap()`

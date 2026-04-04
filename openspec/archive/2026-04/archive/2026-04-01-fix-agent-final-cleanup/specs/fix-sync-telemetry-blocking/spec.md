## MODIFIED Requirements

### Requirement: Async-Safe Queue I/O in SyncTelemetryService
All filesystem operations in `flush()`, `read_queue()`, and `requeue_events()` SHALL use non-blocking I/O when called from async context.

#### Scenario: Flush reads queue without blocking tokio runtime
- **GIVEN** pending telemetry events in the queue file
- **WHEN** `flush()` is called from the async service loop
- **THEN** queue reading uses `tokio::fs` or `spawn_blocking`
- **AND** the tokio runtime thread is not blocked during file I/O

#### Scenario: Requeue preserves events on send failure
- **GIVEN** a batch of events fails to send
- **WHEN** `requeue_events()` writes them back to the queue file
- **THEN** writing uses non-blocking I/O
- **AND** all unsent events are preserved in the queue file

#### Scenario: Existing tests continue to pass
- **GIVEN** the sync_telemetry test suite
- **WHEN** tests run after the migration
- **THEN** all existing tests pass without modification

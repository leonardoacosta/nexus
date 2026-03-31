# receiver-router Specification

## Purpose
TBD - created by archiving change fix-tui-agent-cleanup. Update Purpose after archive.
## Requirements
### Requirement: Extracted Receiver Route Handlers
Each HTTP route handler in `ReceiverService::handle_request` SHALL be an independent async function. The `handle_request` method SHALL act as a thin dispatch table that matches `(method, path)` and delegates to the appropriate handler function. Each handler SHALL accept the request body (or relevant typed input) and the shared `ReceiverState`, and return the HTTP response tuple.

#### Scenario: Dispatch table delegates to handler
- **WHEN** an HTTP request arrives with method `POST` and path `/speak`
- **THEN** `handle_request` delegates to `handle_speak` which deserializes `SpeakRequest`, processes the TTS request, and returns the response

#### Scenario: Unknown route returns 404
- **WHEN** an HTTP request arrives with an unrecognized method/path combination
- **THEN** `handle_request` returns a 404 JSON error response without delegating to any handler

### Requirement: Axum-Based Receiver Transport
`ReceiverService` SHALL use an axum `Router` for HTTP serving instead of manual TCP socket handling. The functions `parse_request`, `format_response`, `handle_connection`, and the manual TCP accept loop SHALL be removed. The axum router SHALL bind to the configured port and serve all existing routes with identical paths, methods, and response formats.

#### Scenario: Axum router serves existing routes
- **WHEN** the receiver service starts
- **THEN** an axum router binds to the configured port and serves all routes (`/health`, `/speak`, `/play`, `/mode`, `/mode/cycle`, `/reload`, `/watch/register`, `/imessage`, `/history`, `/sessions`, `/messages`, `/messages/:id`, `/status/notifications`)

#### Scenario: Raw TCP functions removed
- **WHEN** the receiver is built
- **THEN** `parse_request`, `format_response`, and `handle_connection` do not exist in the codebase


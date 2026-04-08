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

### Requirement: handle_request Timeout
`ReceiverService::handle_request` MUST complete within 5 seconds. Any handler that does not
settle within the deadline MUST return HTTP 504 with a JSON `{ "error": "timeout" }` body
without blocking subsequent requests.

#### Scenario: handler times out returns 504
- **WHEN** a dispatched handler does not complete within 5 seconds
- **THEN** `handle_request` returns HTTP 504 with body `{ "error": "timeout" }`

#### Scenario: fast handler returns normally
- **WHEN** a dispatched handler completes within the timeout
- **THEN** `handle_request` returns the handler's normal response without modification

### Requirement: speak_from_socket Timeout
`ReceiverService::speak_from_socket` MUST apply a 5-second timeout to the outbound HTTP
call. If the call does not settle within 5 seconds it MUST return `Err(Elapsed)` without
blocking the caller.

#### Scenario: HTTP call within timeout succeeds
- **WHEN** the TTS HTTP call completes within 5 seconds with a 2xx status
- **THEN** `speak_from_socket` returns `Ok(true)`

#### Scenario: HTTP call exceeds timeout returns Err
- **WHEN** the TTS HTTP server does not respond within 5 seconds
- **THEN** `speak_from_socket` returns `Err(...)` containing an elapsed timeout error

### Requirement: TTS Retry with Exponential Backoff
The notification engine TTS delivery path MUST retry failed calls up to 3 times using
exponential backoff with base delay 500 ms, maximum delay 4 s, and ±10 % jitter. Each
retry attempt MUST be logged at `WARN` level with the attempt number and computed delay.

#### Scenario: transient failure retried and succeeds
- **WHEN** TTS delivery fails on attempt 1 but succeeds on attempt 2
- **THEN** the notification is delivered and 1 `WARN` log entry is emitted with `attempt=1`

#### Scenario: all attempts exhausted propagates error
- **WHEN** TTS delivery fails on all 3 attempts
- **THEN** `Err(...)` is returned to the caller and 2 `WARN` entries are emitted

### Requirement: Config Reload Guard
The notification engine config reload handler MUST parse the new configuration into a
temporary value before applying it. If parsing fails the previous valid configuration MUST
be retained unchanged and an `ERROR` log entry MUST be emitted with a redacted error
message. A successful parse MUST atomically replace the live configuration.

#### Scenario: valid config applied atomically
- **WHEN** a valid config file is written and the reload signal fires
- **THEN** the engine adopts the new config and logs `INFO "config reloaded successfully"`

#### Scenario: invalid config retained previous
- **WHEN** a malformed config file is written and the reload signal fires
- **THEN** the engine retains the previous config and logs `ERROR` containing `"retaining previous config"`

### Requirement: PII Redaction in Error Logging
All `ERROR` and `WARN` log calls in `notification_engine.rs` MUST pass string arguments
through a `redact()` helper that removes email addresses, HTTP/HTTPS/FTP URLs, and
absolute filesystem paths before writing to the log.

#### Scenario: error message containing email is redacted
- **WHEN** an error message containing `user@example.com` is logged
- **THEN** the log entry contains `[REDACTED_EMAIL]` instead of the address

#### Scenario: error message containing path is redacted
- **WHEN** an error message containing `/home/user/.config/nexus/agents.toml` is logged
- **THEN** the log entry contains `[REDACTED_PATH]` instead of the path

### Requirement: Notification Payload Validation
Incoming notification payloads MUST be validated at the route handler boundary. Payloads
with an empty `message` field or a `message` exceeding 500 characters MUST be rejected with
HTTP 400 and a JSON body `{ "error": "validation", "detail": "<reason>" }`.

#### Scenario: empty message rejected
- **WHEN** a notification payload with `message: ""` is submitted
- **THEN** the handler returns HTTP 400 with `detail: "message is empty"`

#### Scenario: oversized message rejected
- **WHEN** a notification payload with a 501-character message is submitted
- **THEN** the handler returns HTTP 400 with `detail: "message exceeds 500 characters"`

#### Scenario: valid message accepted
- **WHEN** a notification payload with a non-empty message of at most 500 characters is submitted
- **THEN** the handler proceeds normally and returns HTTP 200


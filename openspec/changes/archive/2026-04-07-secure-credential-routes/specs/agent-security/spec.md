## MODIFIED Requirements

### Requirement: Shared Secret Authentication for Run Endpoint
All REST endpoints SHALL require a valid shared secret in the `X-Nexus-Secret` header. The
global auth middleware MUST check the secret before dispatching any REST route. Requests that
omit or provide an invalid secret SHALL be rejected with HTTP 401. WebSocket upgrade paths
(`/sessions/{id}/stream` and `/sessions/{id}/interact`) validate the secret inline before the
upgrade and are exempt from the global middleware check. The secret SHALL be configurable via
`agents.toml` or the `NEXUS_SECRET` environment variable and SHALL be compared using a
constant-time equality function (`crypto.timingSafeEqual`) to prevent timing side-channel
attacks.

#### Scenario: Valid secret provided to REST route
- **WHEN** any REST request (e.g. `GET /sessions`, `POST /credentials`, `GET /health`) includes a valid `X-Nexus-Secret` header
- **THEN** the request is dispatched to its handler normally

#### Scenario: Missing or invalid secret on REST route
- **WHEN** any REST request omits the `X-Nexus-Secret` header or provides an incorrect value
- **THEN** the server responds with HTTP 401 Unauthorized before the route handler is called

#### Scenario: No secret configured
- **WHEN** no secret is configured in agents.toml or environment
- **THEN** the agent refuses to start (fail-closed) and all routes reject with HTTP 401

#### Scenario: Timing-safe comparison prevents oracle
- **WHEN** a request provides a secret of the wrong length or with a single differing byte
- **THEN** the comparison completes without throwing and returns 401, with no observable timing difference relative to a fully mismatched secret

#### Scenario: WebSocket upgrade validates secret inline
- **WHEN** a WebSocket upgrade request to `/sessions/{id}/stream` or `/sessions/{id}/interact` includes an invalid or missing `X-Nexus-Secret`
- **THEN** the server responds with HTTP 401 before the upgrade is attempted

## ADDED Requirements

### Requirement: CORS Allows Auth Header for Browser Clients
The CORS middleware SHALL include `x-nexus-secret` in the `Access-Control-Allow-Headers`
response header so that browser clients hosted at a Tailscale origin can include the auth
header in cross-origin requests. The `Access-Control-Allow-Origin` header SHALL continue to be
scoped to Tailscale origins (`100.x.x.x`) only.

#### Scenario: Browser preflight from Tailscale origin
- **WHEN** an OPTIONS preflight request arrives with an `Origin` header matching `100.x.x.x`
- **THEN** the response includes `Access-Control-Allow-Headers: Content-Type, x-nexus-secret`

#### Scenario: Non-Tailscale origin receives no CORS headers
- **WHEN** a request arrives with an `Origin` that does not match `100.x.x.x`
- **THEN** no `Access-Control-Allow-*` headers are set in the response

### Requirement: Interact WebSocket Write Guard
The WebSocket `message` handler SHALL verify that the sending socket holds the writer lock
via `streamManager.isWriter(ws)` before processing any input. Messages from sockets that do
not hold the writer lock SHALL be silently dropped without writing to the PTY. This enforces
the existing exclusive-writer contract at the message-processing layer.

#### Scenario: Writer socket sends input
- **WHEN** a WebSocket in `interact` mode that holds the writer lock sends a binary or text message
- **THEN** the message is forwarded to the PTY normally

#### Scenario: Non-writer socket sends input
- **WHEN** a WebSocket in `interact` mode that does not hold the writer lock sends a message
- **THEN** the message is silently dropped and no PTY write occurs

### Requirement: Credential ID URL Parameter Sanitization
The agent SHALL validate credential ID path parameters against the pattern
`[a-zA-Z0-9_-]+` before using them in log statements, error responses, or downstream calls.
Requests with IDs that fail validation SHALL be rejected with HTTP 400 Bad Request. This
prevents log injection and reflected-content attacks via crafted credential IDs.

#### Scenario: Valid credential ID in release path
- **WHEN** a request to `POST /credentials/my-cred-01/release` is received
- **THEN** the ID passes validation and the release handler is invoked

#### Scenario: Invalid credential ID rejected
- **WHEN** a request to `POST /credentials/../etc/passwd/release` or an ID containing spaces or HTML characters is received
- **THEN** the server responds with HTTP 400 Bad Request before calling any handler

## ADDED Requirements

### Requirement: Configurable Bind Address
The agent SHALL read `bind_address` from `agents.toml` configuration and bind both HTTP and gRPC servers to the specified address. The default bind address SHALL be `127.0.0.1` (localhost only).

#### Scenario: Default bind to localhost
- **WHEN** no `bind_address` is configured in agents.toml
- **THEN** both HTTP (7401) and gRPC (7400) servers bind to `127.0.0.1`

#### Scenario: Explicit bind address configured
- **WHEN** `bind_address = "0.0.0.0"` is set in agents.toml
- **THEN** both servers bind to `0.0.0.0` as specified

### Requirement: Shared Secret Authentication for Run Endpoint
The `/project/{code}/run` endpoint SHALL require a shared secret in the `X-Nexus-Secret` header. Requests without a valid secret SHALL be rejected with HTTP 401. The secret SHALL be configurable via `agents.toml` or the `NEXUS_SECRET` environment variable.

#### Scenario: Valid secret provided
- **WHEN** a POST request to `/project/{code}/run` includes a valid `X-Nexus-Secret` header
- **THEN** the request is processed normally

#### Scenario: Missing or invalid secret
- **WHEN** a POST request to `/project/{code}/run` omits the `X-Nexus-Secret` header or provides an invalid value
- **THEN** the server responds with HTTP 401 Unauthorized

#### Scenario: No secret configured
- **WHEN** no secret is configured in agents.toml or environment
- **THEN** the `/project/{code}/run` endpoint rejects all requests with HTTP 401

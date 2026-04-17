# terminal-attach Specification

## ADDED Requirements

### Requirement: Server-side origin check blocks non-Tailscale origins
Requests to the agent HTTP server from non-Tailscale origins (as determined by `isTailscaleOrigin` — Origin header hostname matching `^100\.`) SHALL receive a `403 Forbidden` response. This check is defense-in-depth on top of the existing `x-nexus-secret` auth; the auth header remains the primary gate.

#### Scenario: Non-Tailscale browser request is blocked
- **GIVEN** a request with `Origin: https://evil.example.com` and valid `x-nexus-secret` header
- **WHEN** the request hits a non-OPTIONS agent endpoint
- **THEN** the response SHALL be `403 Forbidden`
- **AND** the response body SHALL be a short error (e.g., `{ "error": "origin not allowed" }`)

#### Scenario: Tailscale browser request passes
- **GIVEN** a request with `Origin: https://100.123.45.67` and valid `x-nexus-secret`
- **WHEN** the request hits any agent endpoint
- **THEN** the request SHALL proceed normally (existing auth/routing applies)
- **AND** the response SHALL include the existing CORS headers (`Access-Control-Allow-Origin`, etc.)

#### Scenario: No Origin header passes through
- **GIVEN** a non-browser client (curl, wscat) that doesn't send an `Origin` header, with valid `x-nexus-secret`
- **WHEN** the request hits an agent endpoint
- **THEN** the request SHALL proceed normally
- **AND** the origin check SHALL NOT block it (the auth header is the gate for non-browser clients)

#### Scenario: CORS preflight (OPTIONS) is exempt from origin block
- **GIVEN** a preflight `OPTIONS` request with `Origin: https://100.123.45.67`
- **WHEN** the request is processed
- **THEN** the preflight SHALL return 204/200 with CORS headers
- **AND** the origin check SHALL NOT return 403 (browsers need preflight to succeed before sending the real request)

#### Scenario: Malformed Origin header treated as no-Origin
- **GIVEN** a request with `Origin: not-a-url`
- **WHEN** `isTailscaleOrigin` can't parse the URL
- **THEN** the request SHALL be treated as if Origin is absent (proceed via auth gate)
- **AND** the server SHALL NOT crash on invalid Origin values

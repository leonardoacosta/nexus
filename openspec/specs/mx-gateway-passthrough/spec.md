# mx-gateway-passthrough Specification

## Purpose

Defines the shared contract every nexus-agent route that proxies the mx gateway (127.0.0.1:8799)
must follow, so the skeleton (base URL, timeout, param forwarding, failure posture) lives in one
place instead of being re-derived per route.

## Requirements

### Requirement: mx-gateway read routes SHALL degrade to a per-route empty payload on any failure

Every agent route that proxies a mx-gateway GET endpoint SHALL bound the upstream fetch with a
shared timeout, forward only its declared allowlisted query parameters, and on a non-200 upstream
response or any fetch failure return its own route-specific empty payload with HTTP 200 rather
than propagating an error.

#### Scenario: Non-200 upstream degrades to the empty payload

- **GIVEN** the mx gateway returns a non-200 response for a proxied read route
- **WHEN** the agent route handles the request
- **THEN** the agent responds 200 with that route's empty payload

#### Scenario: Upstream unreachable degrades to the empty payload

- **GIVEN** the mx gateway is unreachable or the fetch times out
- **WHEN** the agent route handles the request
- **THEN** the agent responds 200 with that route's empty payload

#### Scenario: Allowlisted params are forwarded, others are not

- **GIVEN** an incoming request with both allowlisted and non-allowlisted query parameters
- **WHEN** the agent route proxies the request to the gateway
- **THEN** only the allowlisted parameters present on the incoming request are forwarded

### Requirement: mx-gateway write routes SHALL relay the upstream response verbatim and never fabricate success

Every agent route that proxies a mx-gateway POST endpoint SHALL forward the client body, bound the
upstream fetch with the shared timeout, relay the upstream status code and body verbatim for any
response the gateway returns, and map a timeout or network failure to HTTP 504 with a route-specific
error body — never returning a fabricated success status when the write did not reach the gateway.

#### Scenario: Non-2xx upstream response is relayed verbatim

- **GIVEN** the mx gateway responds to a proxied write with a non-2xx status and body
- **WHEN** the agent route handles the request
- **THEN** the agent responds with that same status code and body, unmodified

#### Scenario: Upstream unreachable maps to 504, never a fabricated 200

- **GIVEN** the mx gateway is unreachable or the fetch times out during a proxied write
- **WHEN** the agent route handles the request
- **THEN** the agent responds 504 with that route's unreachable-error body
- **AND** the agent never responds with a 2xx status for that request

### Requirement: All mx-gateway passthrough routes SHALL share one timeout and one base-URL resolution

Every mx-gateway passthrough route in the agent SHALL derive its upstream base URL and fetch
timeout from a single shared source, so a timeout or base-URL change is a one-line edit that
applies to every route rather than requiring N per-route edits.

#### Scenario: A single source of truth for the gateway base URL

- **GIVEN** the `MX_GATEWAY_URL` environment variable is read anywhere in the agent's route layer
- **WHEN** the codebase is inspected
- **THEN** exactly one non-test source file reads `process.env.MX_GATEWAY_URL`

#### Scenario: A single source of truth for the fetch timeout

- **GIVEN** every mx-gateway passthrough route's fetch is bounded by an `AbortController`
- **WHEN** the codebase is inspected
- **THEN** no route file constructs its own `AbortController` — the timeout is applied by the
  shared helper only

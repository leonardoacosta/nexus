## ADDED Requirements

### Requirement: Safe content rendering
The spec events subscriber component MUST NOT render arbitrary HTML via `dangerouslySetInnerHTML`. Markdown or HTML content from spec events MUST be sanitized through an allowlist before rendering.

#### Scenario: Malicious script payload
- **GIVEN** a spec event with content `<script>alert('xss')</script>`
- **WHEN** the subscriber renders the event
- **THEN** the script tag must not execute and must be stripped or escaped

### Requirement: Fetch lifecycle
All fetch and SSE subscriptions in client components MUST be tied to an AbortController scoped to component lifetime; cleanup MUST abort the connection.

#### Scenario: Component unmount mid-request
- **GIVEN** a fetch is in-flight
- **WHEN** the component unmounts
- **THEN** the fetch must be aborted and produce no state update warning

### Requirement: Module separation
The spec events subscriber MUST be split into transport, parsing, and rendering modules. The rendering component MUST NOT exceed 250 lines.

#### Scenario: Rendering module audit
- **GIVEN** the spec-events-subscriber.tsx file after the split
- **WHEN** a reviewer inspects it
- **THEN** the file contains only React rendering code (no fetch, no EventSource, no validation logic) and is under 250 lines

## ADDED Requirements

### Requirement: Browser XTerminal Token Injection
The Next.js `XTerminal` component SHALL append `?token=<secret>` to the WebSocket URL
before connecting, sourcing the token from a server-rendered prop or a protected
`/api/ws-token` API route. The token SHALL NOT be embedded in the client-side JavaScript
bundle as a `NEXT_PUBLIC_*` environment variable. This satisfies the WebSocket upgrade
auth requirement when the caller is a browser (which cannot set custom HTTP headers).

#### Scenario: XTerminal connects successfully in stream mode
- **WHEN** the `XTerminal` component mounts with `mode="stream"` and a valid session ID
- **AND** the server-rendered `wsToken` prop contains the correct `NEXUS_ATTACH_SECRET`
- **THEN** the component constructs a URL of the form
  `ws://<host>/sessions/<id>/stream?token=<secret>` and the WebSocket handshake succeeds

#### Scenario: XTerminal connects successfully in interact mode
- **WHEN** the `XTerminal` component mounts with `mode="interact"` and a valid session ID
- **AND** the `wsToken` prop contains the correct secret
- **THEN** the component constructs a URL of the form
  `ws://<host>/sessions/<id>/interact?token=<secret>` and the handshake succeeds

#### Scenario: Missing token results in 401 and retry cycle
- **WHEN** the `XTerminal` component mounts but `wsToken` is empty or undefined
- **THEN** the WebSocket upgrade is rejected with HTTP 401
- **AND** the component displays an error status rather than silently retrying indefinitely

#### Scenario: Token not visible in client bundle
- **WHEN** the Next.js app is built and the `_next/static/` output is inspected
- **THEN** the value of `NEXUS_ATTACH_SECRET` is not present in any static asset

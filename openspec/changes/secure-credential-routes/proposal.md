# Change: Secure Credential Routes and Fix Auth Gaps

## Why

A platform audit (2026-04-06) found that all REST routes — including credential
add/lease/release — accept requests from any Tailscale peer without checking
`x-nexus-secret`. Combined with a timing-safe comparison gap on the WebSocket
secret check, a missing CORS header, an unused write-guard in the interact
handler, and unsanitized URL parameters, the agent's credential surface is
effectively unauthenticated and leaks internal details through logs.

## What Changes

- **BREAKING** — All REST routes now require a valid `x-nexus-secret` header
  (global middleware, not per-route). Callers that omit the header receive HTTP 401.
- Credential routes (`POST /credentials`, `POST /credentials/lease`,
  `POST /credentials/{id}/release`, `POST /credentials/{id}/report-rate-limit`,
  `GET /credentials`, `GET /credentials/status`) are protected by the global auth
  middleware.
- WebSocket secret comparison is replaced with `crypto.timingSafeEqual` to
  eliminate the timing side-channel (`server.ts:145`).
- CORS `Access-Control-Allow-Headers` is updated to include `x-nexus-secret` so
  browser clients can send the auth header.
- `isWriter()` is called in the WebSocket `message` handler before processing
  input, closing the defense-in-depth gap (`server.ts:364-410`).
- Credential ID path parameters are validated against `[a-zA-Z0-9_-]+` before
  use in logs and error responses (`server.ts:297`).
- Rust `GET /credentials` endpoint in `crates/nexus-agent/src/main.rs:490` gains
  an auth middleware guard matching the TS behavior.
- `isTailscaleOrigin` CORS check is documented as cosmetic (non-browser clients
  bypass CORS by design); it is retained for browser-origin scoping only.
- Credential `value` field is not transmitted over plain HTTP; agent enforces
  that `POST /credentials` is rejected when the connection is not local (loopback)
  and TLS is unavailable.

## Impact

- Affected specs: `agent-security`, `credential-http-endpoint`
- Affected code:
  - `apps/agent/src/server.ts` — global auth middleware, CORS header, isWriter call, timing-safe compare
  - `apps/agent/src/routes/credentials.ts` — credential ID sanitization
  - `crates/nexus-agent/src/main.rs` — Rust credential GET endpoint auth

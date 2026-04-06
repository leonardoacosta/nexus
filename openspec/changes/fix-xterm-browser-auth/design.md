## Context

The browser `WebSocket` API (RFC 6455, implemented in all browsers) does not allow
setting arbitrary HTTP headers during the upgrade handshake. The only mechanism
available to a browser caller for sending a credential is:

1. **Query-string token** — append the secret to the URL: `ws://host/…?token=<secret>`
2. **Cookie** — a `HttpOnly` cookie that the browser sends automatically on same-origin
   requests (requires cookie-based session management)
3. **Subprotocol negotiation** — encode the token in the `Sec-WebSocket-Protocol` header
   (abuses the protocol field; non-standard)
4. **Reverse proxy** — Next.js API route proxies the WebSocket, injects the header
   server-side (adds latency and a long-lived server-side WS)

## Goals / Non-Goals

- **Goals:** Browser terminal works without a 401. Secrets are not leaked into PTY
  child processes. All REST callers include the auth header.
- **Non-Goals:** Full OAuth / session-cookie overhaul. Mutual TLS. Changing the secret
  rotation mechanism.

## Decisions

- **Decision: Query-string token for WebSocket auth**
  - Rationale: Minimal change surface. The URL travels over TLS (Tailscale) so the
    token is not plaintext-visible on the network. Token is validated with
    `timingSafeEqual` before upgrade, same as the header path.
  - Alternative 1 — Cookie: Requires shared cookie domain between Next.js and agent
    (different origins/ports); complex cross-origin cookie policy.
  - Alternative 2 — Subprotocol: Non-standard; confuses WebSocket protocol negotiation
    for protocol clients that inspect `Sec-WebSocket-Protocol`.
  - Alternative 3 — Proxy: Adds server-side WS management in Next.js; increases
    latency and operational complexity for no benefit given Tailscale encryption.

- **Decision: Server-side env var for client token injection**
  - Next.js `NEXT_PUBLIC_*` env vars are embedded in the client bundle at build time —
    the secret would be visible in `_next/static/`. Instead the value is passed as a
    server-rendered prop (from a Server Component or API route) so it never appears in
    static assets.
  - The `/api/ws-token` route (if used) MUST itself be protected by the existing Next.js
    auth layer (or IP restriction) so it is not publicly callable.

- **Decision: Env-var strip by allowlist-inversion (blocklist of known secret names)**
  - Allowlists (only pass known-safe vars) are more secure but break shells that rely on
    `PATH`, `HOME`, `TERM`, `LANG`, etc. A targeted blocklist is safe for this threat
    model (accidental exposure to interactive users) while preserving shell usability.

## Risks / Trade-offs

- Query-string tokens appear in server access logs. Mitigation: agent should log the
  URL path only (not query string) for WS upgrade events. Add log-scrubbing note to
  tasks.
- If the token rotates, active WebSocket connections authenticated with the old token
  remain open (no mid-stream re-auth). This is acceptable given Tailscale short-lived
  keys and manual agent restart to rotate.

## Open Questions

- None blocking implementation.

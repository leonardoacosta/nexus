## Context

The Nexus agent exposes HTTP and WebSocket endpoints on port 7400 within a
Tailscale mesh. Tailscale limits network-layer access to enrolled peers, but
provides no per-request authentication. Any peer that can reach the agent can
currently call credential add/lease/release without supplying `x-nexus-secret`.
Additionally, the WebSocket secret comparison uses a non-constant-time equality
operator, CORS is missing the auth header, the interact message handler skips a
write-guard, and URL parameters from untrusted input flow into logs unvalidated.

Stakeholders: agent daemon, TUI client, Nova integration (`/tmp/nexus-agent.sock`
→ REST on `:7400`), any browser-based dashboard hosted at a Tailscale IP.

## Goals / Non-Goals

- Goals:
  - Require `x-nexus-secret` on all REST routes via a single global middleware
    (not per-route duplication).
  - Eliminate the timing side-channel in WebSocket secret comparison.
  - Allow browser clients to send `x-nexus-secret` by fixing the CORS allowed
    headers.
  - Enforce the `isWriter` guard in the interact message handler for defense-in-
    depth.
  - Sanitize credential ID URL parameters before they enter logs or error text.
  - Mirror the auth requirement on the Rust `GET /credentials` endpoint.
  - Optionally enforce TLS for credential value submission (opt-in via env var).

- Non-Goals:
  - Removing or replacing Tailscale as the network-layer boundary.
  - Per-route or role-based access control (all authenticated callers have equal
    access in this change).
  - Mutual TLS between agent and TUI.
  - Rotating or revoking the shared secret at runtime.

## Decisions

- **Decision: Global middleware over per-route guards.**
  Applying `requireSecret` once at the top of `handleRequest`, after WebSocket
  upgrade paths but before all REST dispatch, ensures every future route is
  protected by default. Per-route opt-in guards have proven unreliable (the
  credential routes being a live example). Exempted paths (WebSocket upgrade
  checks that already validate the secret inline, and OPTIONS preflight) are
  handled before the global check.

  Alternatives considered:
  - Wrapping each route handler: rejected — already demonstrated to be error-
    prone (credential routes were missed).
  - Axum tower middleware layer (Rust side): viable, used for the Rust endpoint;
    for the TS/Bun side the single-function approach is simpler given the
    hand-rolled router.

- **Decision: `crypto.timingSafeEqual` for all secret comparisons.**
  Node's `timingSafeEqual` operates in constant time regardless of where strings
  differ, eliminating the timing oracle. Both the REST middleware and the two
  WebSocket upgrade checks (stream and interact) are updated. The comparison
  normalises a missing header to an empty string before calling
  `Buffer.from(...)` to prevent a throw.

  Alternatives considered:
  - `crypto.subtle.timingSafeEqual` (Web Crypto): available in Bun but requires
    `ArrayBuffer` coercion; `Buffer.from` is equivalent and more idiomatic in
    Node/Bun.

- **Decision: Retain `isTailscaleOrigin` CORS check as-is, fix the header only.**
  The `isTailscaleOrigin` guard scopes CORS to browser clients arriving from a
  Tailscale origin. It is intentionally cosmetic for non-browser (CLI, daemon)
  clients — those clients never send an `Origin` header and are not subject to
  browser CORS enforcement. The check is useful as a narrow allow-list for
  browser dashboards. We add `x-nexus-secret` to `Access-Control-Allow-Headers`
  so a browser can include the auth header in a cross-origin preflight.

  Alternatives considered:
  - Removing the CORS check entirely and allowing all origins: rejected — the
    Tailscale scope provides a meaningful browser allow-list.
  - IP-range allow-list in middleware: already handled by Tailscale ACLs at the
    network layer.

- **Decision: Credential ID regex `[a-zA-Z0-9_-]+` mirrors `SESSION_ID_RE`.**
  Consistent with the existing session ID validation pattern, credential IDs are
  restricted to alphanumeric characters, underscores, and hyphens. This prevents
  path traversal, log injection, and HTML injection in error messages. The
  constant `CREDENTIAL_ID_RE` is placed alongside `SESSION_ID_RE` to make the
  pairing obvious.

- **Decision: TLS enforcement is opt-in via `NEXUS_REQUIRE_TLS`.**
  Localhost-only deployments (dev machines, single-node homelab) commonly run
  without TLS. Forcing TLS would break those deployments. The flag enables
  enforcement in production environments where TLS is present. The default is
  permissive; the check inspects `x-forwarded-proto: https` (set by Traefik or
  similar reverse proxy) as the TLS signal.

## Risks / Trade-offs

- **Breaking change for callers without `x-nexus-secret`**: any integration
  (Nova, scripts, dashboards) that calls REST endpoints without the header will
  receive 401. Mitigation: all known callers already send the header for
  WebSocket routes; update them to include it on REST calls before deploying.

- **`timingSafeEqual` throws if buffers differ in length**: mitigated by
  padding-to-same-length via empty-string normalisation; unit tests cover the
  length-mismatch case.

- **Rust `GET /credentials` is a separate binary**: the auth change must be
  coordinated so both the TS daemon and the Rust daemon are updated in the same
  release. If only one is updated, behaviour diverges on machines running the
  mixed fleet.

## Migration Plan

1. Update `apps/agent/src/server.ts` with global middleware and CORS fix.
2. Update `apps/agent/src/server.ts` with timing-safe comparisons.
3. Update `apps/agent/src/server.ts` with isWriter guard.
4. Update `apps/agent/src/server.ts` with `CREDENTIAL_ID_RE` validation.
5. Update `apps/agent/src/routes/credentials.ts` with TLS enforcement helper.
6. Update `crates/nexus-agent/src/main.rs` with auth middleware on `GET /credentials`.
7. Update all known REST callers (Nova integration, TUI HTTP client) to include `x-nexus-secret`.
8. Deploy agent binary and TS daemon together in a single release.
9. Rollback: revert the middleware addition; credential routes become open again.

## Open Questions

- Should `GET /health` be exempted from the global auth check to preserve
  compatibility with health-check probes (uptime monitors, load balancers) that
  cannot send a custom header? Current proposal: health is protected. If probes
  need it, add an explicit exemption once the use-case is confirmed.
- Should `GET /credentials` (list, no values) be read-only and thus require only
  the secret, while `POST /credentials` (add, with value) additionally require
  TLS? The current proposal treats all credential routes uniformly under the
  global secret check.

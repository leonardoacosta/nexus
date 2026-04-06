## 1. Global REST Auth Middleware

- [ ] 1.1 Add a `requireSecret(request: Request): Response | null` helper in `server.ts` that
  reads `x-nexus-secret`, calls `timingSafeEqual`, and returns `new Response("Unauthorized", { status: 401 })` on failure or `null` on success.
- [ ] 1.2 Call `requireSecret` at the top of the `handleRequest` function, after WebSocket
  upgrade checks and before any REST route dispatch, so all REST routes inherit the check.
- [ ] 1.3 Write a unit test: requests without `x-nexus-secret` to `/credentials`, `/sessions`,
  `/projects`, `/health`, and `/notifications/send` all return 401.
- [ ] 1.4 Write a unit test: requests with the correct `x-nexus-secret` value are passed through to the route handler.

## 2. Timing-Safe WebSocket Secret Comparison

- [ ] 2.1 Import `timingSafeEqual` from `node:crypto` in `server.ts`.
- [ ] 2.2 Replace the `!==` string comparison at `server.ts:145` and `server.ts:176` with:
  `!timingSafeEqual(Buffer.from(provided), Buffer.from(ATTACH_SECRET))`.
- [ ] 2.3 Handle the edge case where the provided header value is missing (treat as empty string
  before the comparison to avoid a `Buffer.from(null)` throw).
- [ ] 2.4 Write a unit test: a request with a header value of different byte length still returns
  401 without throwing.

## 3. CORS Header Fix

- [ ] 3.1 In `withCors`, update `Access-Control-Allow-Headers` from `"Content-Type"` to
  `"Content-Type, x-nexus-secret"`.
- [ ] 3.2 Write a test: an OPTIONS preflight from a Tailscale origin receives the updated header.

## 4. isWriter Guard in Interact Message Handler

- [ ] 4.1 In the `message` WebSocket handler (`server.ts:364`), add a guard at the top of the
  `mode === "interact"` branch: call `streamManager.isWriter(ws)` and return early (drop the
  message silently) if it returns false.
- [ ] 4.2 Write a unit test: a non-writer socket in interact mode that sends a message has it
  dropped and no PTY write occurs.

## 5. Credential ID URL Parameter Sanitization

- [ ] 5.1 Add a `CREDENTIAL_ID_RE = /^[a-zA-Z0-9_-]+$/` constant near the existing
  `SESSION_ID_RE` in `server.ts`.
- [ ] 5.2 In the `credReleaseMatch` handler (`server.ts:297`), validate
  `CREDENTIAL_ID_RE.test(credReleaseMatch[1]!)` before calling `handleReleaseCredential`;
  return HTTP 400 if it fails.
- [ ] 5.3 Apply the same validation to the `credRateLimitMatch` handler.
- [ ] 5.4 Write unit tests: IDs containing `../`, spaces, or `<script>` tags return 400.

## 6. Rust Credential GET Auth Middleware

- [ ] 6.1 In `crates/nexus-agent/src/main.rs`, add an Axum middleware or extractor that checks
  `X-Nexus-Secret` on the `GET /credentials` route.
- [ ] 6.2 The Rust secret value MUST be sourced from the same env var (`NEXUS_SECRET`) or
  `agents.toml` field as the existing `/project/{code}/run` guard.
- [ ] 6.3 Write a Rust integration test: `GET /credentials` without the header returns 401.

## 7. Credential Value TLS Enforcement

- [ ] 7.1 In `handleAddCredential` (`routes/credentials.ts`), inspect the `x-forwarded-proto`
  header (or a custom `NEXUS_REQUIRE_TLS=true` env flag). When set, reject `POST /credentials`
  requests that arrive over plain HTTP with HTTP 403 and message `"credentials must be
  submitted over TLS"`.
- [ ] 7.2 Document the TLS enforcement behavior in a code comment; the default is permissive
  (localhost-only deployments without TLS are valid).
- [ ] 7.3 Write a unit test for both branches: TLS header present → allowed; flag set and no TLS
  header → 403.

## 8. Validation and Quality Gates

- [ ] 8.1 Run `openspec validate secure-credential-routes --strict --no-interactive` and confirm
  zero errors.
- [ ] 8.2 Run `bun test` across `apps/agent` and confirm all new tests pass.
- [ ] 8.3 Run `cargo test -p nexus-agent` and confirm the Rust test passes.
- [ ] 8.4 Run `cargo clippy -p nexus-agent -- -D warnings` with no new warnings.

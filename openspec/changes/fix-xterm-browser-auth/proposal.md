# Change: Fix XTerminal browser WebSocket auth and close two auth gaps

## Why

Three auth defects were discovered in the browser terminal and agent client:

1. **P1 — XTerminal WS auth bypass:** The browser `WebSocket` API cannot set custom
   headers like `x-nexus-secret`. `XTerminal.tsx` constructs `new WebSocket(url)` with
   no auth mechanism, so every WebSocket upgrade attempt from the browser is rejected
   with HTTP 401 before the connection is established (silent failure). The existing
   `secure-credential-routes` spec incorrectly assumes "browser clients can send the
   auth header" — this proposal fixes that assumption and provides the real solution.

2. **P1 — `updateCommand()` missing auth header:** `AgentClient.updateCommand()` sends
   `PUT /commands/:name` without the `x-nexus-secret` header. All other methods in the
   file include it. The method was missed when the file was hardened for `fetchWithRetry`
   and `startSession`.

3. **P2 — PTY child process inherits full `process.env`:** `NodePtySource` defaults to
   `process.env` when no explicit `env` is passed. This leaks `NEXUS_ATTACH_SECRET`,
   `NEXUS_ENCRYPTION_KEY`, `POSTGRES_URL`, and `SENTRY_DSN` into every interactive
   shell — any user running `env` in the terminal can extract all secrets.

## What Changes

- **BREAKING (WS auth)** — The agent WebSocket upgrade handler accepts the secret via
  a `token` query-string parameter in addition to the `x-nexus-secret` header. This is
  the only mechanism available to the browser `WebSocket` API without a proxy layer.
  Token is validated with `crypto.timingSafeEqual` before the upgrade proceeds.
  (`apps/agent/src/server.ts`)

- The Next.js `XTerminal.tsx` component appends `?token=<secret>` to the WebSocket URL.
  The secret is sourced from the `NEXUS_ATTACH_SECRET` environment variable (or a
  server-side API route that proxies it) and never exposed in rendered HTML.
  (`apps/nextjs/src/components/XTerminal.tsx:83`)

- `AgentClient.updateCommand()` gains the `x-nexus-secret` header to match every other
  method in the file. (`apps/nextjs/src/lib/agent-client.ts:404`)

- `NodePtySource` strips a hardcoded list of sensitive env var names before passing
  `env` to `node-pty`. The stripped names are: `NEXUS_ATTACH_SECRET`,
  `NEXUS_ENCRYPTION_KEY`, `POSTGRES_URL`, `DATABASE_URL`, `SENTRY_DSN`,
  `SENTRY_AUTH_TOKEN`. A caller may still pass an explicit `env` override to opt out
  of the strip. (`apps/agent/src/terminal/pty-source.ts:93`)

- The `secure-credential-routes` spec's ADDED requirement "CORS middleware SHALL include
  `x-nexus-secret` in Access-Control-Allow-Headers" is correct for REST. The new
  requirement added here covers query-string token auth for WebSocket specifically.

## Impact

- Affected specs: `agent-security`, `terminal-attach`
- Affected code:
  - `apps/agent/src/server.ts` — query-string token support on WS upgrade paths
  - `apps/nextjs/src/components/XTerminal.tsx` — append `?token=` to WS URL
  - `apps/nextjs/src/lib/agent-client.ts` — add header to `updateCommand()`
  - `apps/agent/src/terminal/pty-source.ts` — strip sensitive env vars before spawn

## Relationship to Other Changes

- `secure-credential-routes` — Covers REST auth, CORS, timing-safe comparison. The CORS
  delta in that change adds `x-nexus-secret` to `Access-Control-Allow-Headers` for REST
  preflight. This change does NOT modify that delta; it adds a separate WS token
  mechanism that is independent of CORS.
- `fix-pty-lifecycle` — Covers PTY orphan cleanup, reconnect buffer, writer mutex. This
  change adds env-var stripping to `NodePtySource` which is orthogonal to lifecycle.

## 1. Agent — WebSocket query-string token auth

- [x] 1.1 Update `requireSecret()` (or add `requireSecretWs()`) in `apps/agent/src/server.ts` to
       accept the secret from the `token` query-string parameter as a fallback when the
       `x-nexus-secret` header is absent. Validate with `crypto.timingSafeEqual`.
- [x] 1.2 Apply the new WS auth check to the stream upgrade path
       (`apps/agent/src/server.ts` — `WS_STREAM_RE` match block).
- [x] 1.3 Apply the new WS auth check to the interact upgrade path
       (`apps/agent/src/server.ts` — `WS_INTERACT_RE` match block).
- [x] 1.4 Write tests: missing token → 401, wrong token → 401, correct token → upgrade succeeds.

## 2. Next.js — XTerminal token injection

- [x] 2.1 Expose `NEXUS_ATTACH_SECRET` as a server-side Next.js env var
       (add to `.env.example` if not already present, document in README if applicable).
- [x] 2.2 Update `XTerminal.tsx:83` to append `?token=${secret}` to the WebSocket URL.
       Source the value from a server-rendered prop or a lightweight `/api/ws-token` route
       so the secret is never embedded in static client bundles.
- [x] 2.3 Verify that the terminal connects successfully in both `stream` and `interact`
       modes without a 401.

## 3. Agent client — updateCommand auth header

- [x] 3.1 Add `"x-nexus-secret": process.env.NEXUS_ATTACH_SECRET ?? ""` to the `fetch`
       headers in `AgentClient.updateCommand()` at `apps/nextjs/src/lib/agent-client.ts:404`.
- [x] 3.2 Add or update unit test: `updateCommand()` request includes the header.

## 4. PTY — strip sensitive env vars

- [x] 4.1 Define `SENSITIVE_ENV_KEYS` constant in `apps/agent/src/terminal/pty-source.ts`
       listing: `NEXUS_ATTACH_SECRET`, `NEXUS_ENCRYPTION_KEY`, `POSTGRES_URL`,
       `DATABASE_URL`, `SENTRY_DSN`, `SENTRY_AUTH_TOKEN`.
- [x] 4.2 In `NodePtySource` constructor: when `opts.env` is not provided, start from
       `process.env` and delete each key in `SENSITIVE_ENV_KEYS` before passing to
       `node-pty`. When `opts.env` is provided explicitly, pass it as-is (caller controls).
- [x] 4.3 Add unit test: spawn with default env → spawned shell env does not contain
       `NEXUS_ATTACH_SECRET`. Spawn with explicit `opts.env` → env is passed unchanged.

## 5. Validation

- [x] 5.1 Run `openspec validate fix-xterm-browser-auth --strict --no-interactive` and
       confirm zero errors.
- [x] 5.2 Run `pnpm typecheck` and `pnpm lint` — zero new errors.
- [x] 5.3 Run `pnpm test` — existing tests pass, new tests pass.

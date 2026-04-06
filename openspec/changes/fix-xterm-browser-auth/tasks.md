## 1. Agent — WebSocket query-string token auth

- [ ] 1.1 Update `requireSecret()` (or add `requireSecretWs()`) in `apps/agent/src/server.ts` to
       accept the secret from the `token` query-string parameter as a fallback when the
       `x-nexus-secret` header is absent. Validate with `crypto.timingSafeEqual`.
- [ ] 1.2 Apply the new WS auth check to the stream upgrade path
       (`apps/agent/src/server.ts` — `WS_STREAM_RE` match block).
- [ ] 1.3 Apply the new WS auth check to the interact upgrade path
       (`apps/agent/src/server.ts` — `WS_INTERACT_RE` match block).
- [ ] 1.4 Write tests: missing token → 401, wrong token → 401, correct token → upgrade succeeds.

## 2. Next.js — XTerminal token injection

- [ ] 2.1 Expose `NEXUS_ATTACH_SECRET` as a server-side Next.js env var
       (add to `.env.example` if not already present, document in README if applicable).
- [ ] 2.2 Update `XTerminal.tsx:83` to append `?token=${secret}` to the WebSocket URL.
       Source the value from a server-rendered prop or a lightweight `/api/ws-token` route
       so the secret is never embedded in static client bundles.
- [ ] 2.3 Verify that the terminal connects successfully in both `stream` and `interact`
       modes without a 401.

## 3. Agent client — updateCommand auth header

- [ ] 3.1 Add `"x-nexus-secret": process.env.NEXUS_ATTACH_SECRET ?? ""` to the `fetch`
       headers in `AgentClient.updateCommand()` at `apps/nextjs/src/lib/agent-client.ts:404`.
- [ ] 3.2 Add or update unit test: `updateCommand()` request includes the header.

## 4. PTY — strip sensitive env vars

- [ ] 4.1 Define `SENSITIVE_ENV_KEYS` constant in `apps/agent/src/terminal/pty-source.ts`
       listing: `NEXUS_ATTACH_SECRET`, `NEXUS_ENCRYPTION_KEY`, `POSTGRES_URL`,
       `DATABASE_URL`, `SENTRY_DSN`, `SENTRY_AUTH_TOKEN`.
- [ ] 4.2 In `NodePtySource` constructor: when `opts.env` is not provided, start from
       `process.env` and delete each key in `SENSITIVE_ENV_KEYS` before passing to
       `node-pty`. When `opts.env` is provided explicitly, pass it as-is (caller controls).
- [ ] 4.3 Add unit test: spawn with default env → spawned shell env does not contain
       `NEXUS_ATTACH_SECRET`. Spawn with explicit `opts.env` → env is passed unchanged.

## 5. Validation

- [ ] 5.1 Run `openspec validate fix-xterm-browser-auth --strict --no-interactive` and
       confirm zero errors.
- [ ] 5.2 Run `pnpm typecheck` and `pnpm lint` — zero new errors.
- [ ] 5.3 Run `pnpm test` — existing tests pass, new tests pass.

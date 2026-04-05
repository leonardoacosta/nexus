# Proposal

## Change ID

fix-terminal-attach-security

## Summary

Harden the WebSocket PTY attach subsystem against unauthorized access, resource exhaustion, and
unsafe inputs. Addresses three P1 security/stability bugs (no auth, no rate limiting, PTY leak on
shutdown) and four P2 correctness issues (backpressure, dead-client cleanup, resize validation,
reconnect state loss).

## Context

The nexus-agent exposes `/sessions/{id}/stream` and `/sessions/{id}/interact` WebSocket endpoints
that fan out PTY output and accept interactive keyboard input. As of the audit (epic nx-ie64) these
endpoints accept connections from any Tailscale peer without authentication, impose no limit on
concurrent connections, and do not drain running PTY processes when the agent shuts down.

Key files:
- `apps/agent/src/server.ts` — WebSocket routing, auth, rate limiting
- `apps/agent/src/terminal/stream-manager.ts` — PTY fan-out, backpressure
- `apps/agent/src/terminal/pty-source.ts` — PTY spawn interface
- `apps/agent/src/index.ts` — shutdown sequence

## Motivation

- **nx-4wn2 (P1):** Any Tailscale peer can open a full interactive shell with no credential check.
- **nx-dtk5 (P1):** Unbounded WebSocket connections exhaust file descriptors and memory.
- **nx-acu2 (P1):** `streamManager.shutdown()` is never called on SIGTERM, leaving PTY child
  processes running indefinitely after the agent exits.
- **nx-g7ru (P2):** Fan-out loop calls `ws.sendBinary` unconditionally; a slow client's
  `bufferedAmount` can grow without bound, causing OOM.
- **nx-bg01 (P2):** Pong timeout closes the WebSocket but `removeViewer` does not call
  `endSession`, leaving the PTY alive with no viewers.
- **nx-wjqs (P2):** Resize message only checks `typeof === "number"`, allowing `NaN` or
  `Infinity` to reach `pty.resize()`.
- **nx-j2ap (P3):** Session IDs taken from the URL are used as map keys without validation;
  a path-traversal-style ID could cause misbehavior if IDs are ever used with the filesystem.
- **nx-xxq5 (P3):** `isTailscaleOrigin` only sets CORS response headers, never rejects
  non-browser requests that omit the Origin header.
- **nx-9evk (P3):** Only `MockPtySource` exists; no real PTY spawn implementation.

## Requirements

1. **Req-1** — Auth before PTY attach (`X-Nexus-Secret` header validation before WebSocket upgrade)
2. **Req-2** — Rate limiting (`MAX_CONCURRENT_CONNECTIONS` constant, 429 when exceeded)
3. **Req-3** — Graceful shutdown drains PTY (`streamManager.shutdown()` in shutdown sequence)
4. **Req-4** — Backpressure-safe fan-out (bufferedAmount check, pause PTY when buffer full)
5. **Req-5** — Clean PTY cleanup on all disconnect paths (pong timeout, close, server stop)
6. **Req-6** — Resize input validation (1 ≤ cols ≤ 500, 1 ≤ rows ≤ 300)

## Scope

**In scope:**
- `apps/agent/src/server.ts` — auth guard, rate limit, pong-timeout cleanup
- `apps/agent/src/terminal/stream-manager.ts` — backpressure, endSession on last-viewer disconnect
- `apps/agent/src/index.ts` — shutdown sequence fix
- Resize message validation in the WebSocket `message` handler

**Out of scope:**
- Real `PtySource` implementation (nx-9evk is P3 backlog)
- Reconnect/resume support (nx-zeu7 is P2, tracked separately)
- CORS enforcement beyond header setting (nx-xxq5 is P3)
- New UI or database schema changes

## Impact

- **Affected specs:** `terminal-attach`
- **Affected code:** `server.ts`, `stream-manager.ts`, `index.ts`
- **Breaking changes:** none — `X-Nexus-Secret` header is a new requirement for clients; existing
  clients that omit it will receive HTTP 401 before upgrade.

## Risks

- **Secret bootstrap:** Agents must have the secret available at startup. If `NEXUS_ATTACH_SECRET`
  is not set the agent should refuse all attach connections (fail-closed).
- **Backpressure complexity:** Pausing PTY output when any viewer is slow affects all viewers.
  A per-viewer drop-or-disconnect policy should be considered during implementation.
- **Shutdown race:** Calling `streamManager.shutdown()` before `server.stop()` ensures PTY children
  are reaped, but Bun's `server.stop()` may still deliver queued close events after shutdown. The
  implementation must be idempotent.

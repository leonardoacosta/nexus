---
order: 0724d
---

# Proposal: chmod 0600 the Agent UNIX Socket After Bind

## Change ID
`chmod-agent-socket`

> Advisor stamp: 2026-07-24 `/improve` run against commit `9e4963b9`. Verify cited lines before starting; STOP on drift.

## Summary
`apps/agent/src/services/socket-server/server.ts:23` defaults the IPC socket to `/tmp/nexus-agent.sock` (`resolveSocketPath()`, line ~57, falls back when `NEXUS_SOCKET` is unset) and never sets a mode after `Bun.listen` — the socket file gets umask-derived perms in world-writable `/tmp`. Socket events are unauthenticated by design, and a `notification` event matching `RATE_LIMIT_PHRASES` (`dispatcher.ts:660`) triggers a real credential swap plus a `"continue"` injection into a session's tmux pane (`dispatcher.ts:706`). On a multi-user host, any local user can connect. Harden the file mode to 0600 after bind. Deploy tooling socats to the `/tmp` path (`deploy/hooks.d/post-merge/02-deploy`), so the default path must NOT move — perms only.

## Context
- depends on:
- touches: `apps/agent/src/services/socket-server/server.ts`, `apps/agent/src/services/socket-server/server.test.ts` (new)

## Motivation
Found by the 2026-07-24 advisor audit (security, MED confidence — severity gated on multi-user hosts). The repo already treats 0600 as the convention for sensitive files: `apps/agent/src/cc-credential-manager.ts:194` and `apps/agent/src/health-push/device-token-store.ts:59` both write with `mode: 0o600`. The socket is the same trust class and should match.

## Testing
- New unit test asserting the bound socket file's mode is `0600` on both the default and a `NEXUS_SOCKET`-overridden path — follow the harness style of the existing `apps/agent/src/services/socket-server/*.test.ts` suites.
- `bun test apps/agent/src/services/socket-server` green.

## Done Means
- The socket file at either path reports mode 0600 after the agent binds.
- CC hook ingest via `nexus-emit` (same uid) keeps working; deploy's socat notification line keeps working.
- Other uids get EACCES attempting to connect via the default `/tmp` path.

## Scope
- **IN**: one `fs.chmodSync(path, 0o600)` after successful listen; the mode-assertion test.
- **OUT**: changing `DEFAULT_SOCKET_PATH` (deploy depends on it); adding event auth (settled posture per `drop-attach-secret-gate`); dispatcher logic.
- Escape hatch: if CC hooks / `nexus-emit` ever run as a different uid than the agent (they do not today), STOP — 0600 would break ingest; report back.

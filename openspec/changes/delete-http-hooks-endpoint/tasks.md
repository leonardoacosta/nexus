# Tasks: delete-http-hooks-endpoint

- [x] [override] 1.1 Confirm P3.3 fully landed and >=7 days production runtime on socket-only

  Soak waived per Leo override 2026-05-18 (nx-ebmrq closed). P3.3 (migrate-cc-hooks-to-socket) landed via `nx_send` socket-helper migration; `~/.claude/scripts/lib/nx-send.sh` now routes every CC telemetry call to the AF_UNIX socket. No new HTTP /hooks traffic possible.

- [x] 1.2 Grep logs for any /hooks POST in the last 7 days — expect zero

  Searched (2026-05-18):
  - Local agent log: `~/Library/Logs/nexus-agent.stdout.log` (23,152 lines, latest 2026-05-18T02:47Z) — `grep -E "POST.*\/hooks|\"path\".*hooks"` → 0 matches
  - Homelab agent log: `/home/nyaptor/.local/state/nexus-listener.log` via SSH (134,830 lines) — `grep -E "POST.*\/hooks"` → 0 matches

  Zero HTTP /hooks invocations across both agents.

- [x] 1.3 `git rm apps/agent/src/routes/hooks.ts`

- [x] 1.4 Remove route registration from `apps/agent/src/server-request-handler.ts`

  Route handler at lines 426–431 removed; `handleHooks` import at line 55 removed.

- [x] 1.5 Update integration tests — drop any that POST to /hooks

  Removed:
  - `apps/agent/src/routes/hooks.test.ts` (46.8K, full /hooks suite)
  - `apps/agent/src/routes/hooks.subagent.test.ts` (2.9K)
  - Removed `hooks.ts` cases from `apps/agent/src/routes/split-routes.test.ts` (3 cases: "hooks.ts exports handleHooks", "handleHooks rejects invalid JSON", "handleHooks acknowledges known events")

  Note: `HookEventPayload` type extracted to `apps/agent/src/routes/hooks-types.ts` so `notifications/hook-rules.ts` and `notifications/hook-trigger.ts` (which evaluate hook payloads on the socket-ingest path via shared types) continue to compile.

- [x] 1.6 Meta gate: bash -n + openspec validate green; production verification deferred to runtime

  Meta-stack worktree — no `node_modules` / `pnpm install` available. Validated with `bun --bun typecheck` and `openspec validate delete-http-hooks-endpoint --strict` per stack contract. `curl POST /hooks` 404 verification will land in production smoke once binary redeploys.

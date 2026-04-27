# Implementation Tasks

<!-- beads:epic:nx-v0bx9 -->
<!-- beads:feature:nx-4gv0w -->

## DB Batch

- [x] [1.1] [P-1] No schema changes — placeholder retained for /apply batch ordering [owner:db-engineer] [type:db] [beads:nx-2f3z1]

## API Batch

- [x] [2.1] [P-1] Delete `requireSecret`, the auth-exempt path set, and `isAuthExemptPath` from `apps/agent/src/server-auth.ts`; if the file is left empty after the removal, delete it [owner:api-engineer] [type:api] [beads:nx-yd0d1]
- [x] [2.2] [P-1] Delete the auth dispatch block in `apps/agent/src/server-request-handler.ts` (the `if (!isAuthExemptPath(...)) { requireSecret(...) }` block at lines ~100-108) and remove the corresponding imports [owner:api-engineer] [type:api] [beads:nx-ytv7d]
- [x] [2.3] [P-2] Implement Tailscale interface discovery in `apps/agent/src/server.ts`: shell out to `tailscale ip -4` via `Bun.spawn`, capture stdout, fall back to loopback-only on non-zero exit. Cache result; do not re-query per request [owner:api-engineer] [type:api] [beads:nx-d21sj]
- [x] [2.4] [P-2] Modify `Bun.serve` invocation in `apps/agent/src/server.ts` to bind to a list of addresses (loopback plus Tailscale IP) when `bind_address` is unset or `"0.0.0.0"`; preserve single-bind for explicit values [owner:api-engineer] [type:api] [beads:nx-m2tsk]
- [x] [2.5] [P-3] Add bun tests for the new bind logic: default multi-bind, Tailscale-unavailable fallback, explicit override [owner:test-writer] [type:testing] [beads:nx-hc2zd]
- [x] [2.6] [P-3] Update or remove `apps/agent/src/server-auth.test.ts` (and any other test that pinned the auth gate) to reflect the no-auth contract [owner:test-writer] [type:testing] [beads:nx-pljxz]

## UI Batch

- [x] [3.1] [P-1] Strip 4 occurrences of the `x-nexus-secret` header injection from `apps/nextjs/src/lib/agent-client.ts` and remove the env-var read [owner:ui-engineer] [type:api] [beads:nx-35o8x]
- [x] [3.2] [P-1] Strip the header from `apps/nextjs/src/app/actions/notifications.ts` (`authHeaders()` helper), `apps/nextjs/src/app/actions/credentials.ts` (lines 231, 302), `apps/nextjs/src/app/actions/elevenlabs-credentials.ts` (line 92), `apps/nextjs/src/app/credentials/page.tsx` (line 101), `apps/nextjs/src/app/stream/route.ts` (line 34) — single-line edits each [owner:ui-engineer] [type:api] [beads:nx-bota4]
- [x] [3.3] [P-1] Strip the header from `apps/nexus-status/src/index.ts` (line 126 `ATTACH_SECRET` const, line 39 doc comment, all header injections) [owner:ui-engineer] [type:api] [beads:nx-11ylv]
- [x] [3.4] [P-2] Update `apps/nextjs/src/lib/agent-reachability.ts` to drop any header sending (the version probe is already auth-exempt; this is for consistency now that the gate is gone) [owner:ui-engineer] [type:api] [beads:nx-3eug1]
- [x] [3.5] [P-3] Verify no remaining header in source: `rg -n 'x-nexus-secret' apps/ packages/ tests/` returns zero matches; document in commit message [owner:ui-engineer] [type:testing] [beads:nx-ro9m6]

## E2E Batch

- [x] [4.1] Strip `x-nexus-secret` from `deploy/nexus-notifier.sh` (lines 169, 540) and remove the env-var fallback read (lines 83-89) [owner:e2e-engineer] [type:config] [beads:nx-lerur]
- [x] [4.2] Remove the env-var entry from `.env.example` and the deploy/README.md env-var table + systemd Environment line [owner:e2e-engineer] [type:docs] [beads:nx-4xylb]
- [x] [4.3] Remove `NEXUS_ATTACH_SECRET` from `turbo.json` `test` task env list and from the apps/agent test setup if present; update any test helper that hardcodes the value [owner:e2e-engineer] [type:config] [beads:nx-k1o3w]
- [x] [4.4] E2E gate: rebuild homelab agent + restart, then curl `http://127.0.0.1:7400/health` (no header → expect 200) and `curl http://192.168.x.x:7400/health` (LAN IP → expect connection refused). Paste both outputs in the apply commit message as runtime evidence [owner:e2e-engineer] [type:testing] [beads:nx-kc6z8]
- [x] [4.5] E2E test: remove the `x-nexus-secret` header injection from `tests/e2e/agent-version-handshake.test.ts` and any other existing test that sets it; confirm both tests still pass [owner:e2e-engineer] [type:testing] [beads:nx-dcsyp]
- [ ] [4.6] Verify Mac notifier still delivers TTS after the deploy: trigger a notification on homelab, confirm Mac listener receives + plays it. Manual verification gate [owner:e2e-engineer] [type:testing] [beads:nx-m8nhx]

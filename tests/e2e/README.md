# tests/e2e

End-to-end tests for the finalize-audit-cleanup dual-path collapse.

These tests run against **real Postgres** (docker-compose.test.yml) and a **real agent
HTTP/WS server**. They are the first E2E tests in the repo — no Playwright harness
exists yet; this directory is the initial scaffolding.

## Why bun:test instead of Playwright

- The regressions being guarded are *data-flow* (DB read path) and *WebSocket transport*,
  not rendered CSS/UX. Headless-browser drive would add substantial infra (Playwright,
  browser downloads, shared-state coordination between Next.js server + agent + DB)
  without catching a different class of bug.
- The rest of the repo uses `bun:test` (apps/agent) and `vitest` (apps/nextjs). A third
  runner isn't worth the tax.
- When real Playwright coverage is needed (visual regression, multi-route flows), a new
  `tests/e2e/playwright/` subdirectory can be added alongside these bun tests.

## Running

```bash
# One-time: start test Postgres and push schema
docker compose -f docker-compose.test.yml up -d
POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test pnpm --filter @nexus/db db:push

# Run all e2e tests
POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test \
  bun test tests/e2e/
```

Tests **skip** (do not fail) when prerequisites are missing:

- `POSTGRES_URL` pointing at a reachable Postgres
- `tmux` binary on PATH (only required by future tests — not needed for current ones)

The agent no longer requires an `x-nexus-secret` header (`drop-attach-secret-gate`);
e2e tests do not need to set `NEXUS_ATTACH_SECRET` in their environment.

## Test inventory

| File | Tasks | What it proves |
|------|-------|----------------|
| `dashboard-offline.test.ts` | [5.2] nx-3wpy | Dashboard renders from Postgres when all agents are stopped. Banner copy and session row are present. Regression guard for the fetchAllSessions HTTP fan-out removal. |
| `attach-websocket.test.ts` | [5.3] nx-cjz0 | Attach path `/sessions/:id/stream` still delivers PTY output via WebSocket when the agent is up. Regression guard: the dual-path collapse must not have broken the live attach boundary. |

## Future work

- Wire `pnpm --filter @nexus/e2e test` or a workspace script once a third real e2e test
  lands. For now these two are invoked directly via `bun test tests/e2e/`.
- Consider Playwright when visual/multi-step browser flows appear (e.g. modal dialogs,
  drag-and-drop on the upcoming sessions board).

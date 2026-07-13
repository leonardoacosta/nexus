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
- The rest of the repo uses `bun:test` (apps/agent). A third runner isn't worth the tax.
- When real Playwright coverage is needed (visual regression, multi-route flows), a new
  `tests/e2e/playwright/` subdirectory can be added alongside these bun tests.

## Running

```bash
# One-time: start test Postgres and apply migrations (throwaway DB — db:migrate, never db:push)
docker compose -f docker-compose.test.yml up -d
POSTGRES_URL=postgres://nexus:nexus@localhost:5433/nexus_test pnpm --filter @nexus/db db:migrate

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
| `attach-websocket.test.ts` | [5.3] nx-cjz0 | Attach path `/sessions/:id/stream` still delivers PTY output via WebSocket when the agent is up. Regression guard: the dual-path collapse must not have broken the live attach boundary. |
| `credential-watcher.test.ts` | [4.1] nx-urgv | File watcher's LIVE `fs.watch` loop (not just the boot-time initial scan) detects a new `acct-*.json` dropped into the credential directory post-start and inserts a real row via `pool.add()` against real Postgres. |

## Playwright suite (`playwright/`)

Browser-driven E2E for the web terminal (`apps/web`), added by
`wterm-web-terminal` Batch 4. These ARE the "real Playwright coverage" the
section below anticipated. Stack under test is fully real — no mocks:

- Next.js web app served in **production** mode (`next start`, not `next dev` —
  the dev HMR WebSocket fails its handshake on the Tailscale IP and wedges
  client hydration so the `"use client"` poll never runs).
- The already-running Nexus agent (`GET /sessions`, `POST /session/start`,
  WS `/sessions/:id/{stream,interact}`).
- Real Postgres (`POSTGRES_URL`) + real tmux panes (a dedicated
  `bash --noprofile --norc` window per test, for deterministic output).

| File | Task | What it proves |
|------|------|----------------|
| `web-terminal-journey.spec.ts` | [4.1] nx-64r21 | Full journey: home lists active sessions -> attach -> bash prompt renders in DOM -> type `echo <marker>` -> echoed output renders (live duplex round-trip) -> return home -> same session still listed + re-attachable (server-persisted). |
| `renderer-throughput.spec.ts` | [4.2] nx-7v884 | GATE: streams ~2 MB through the attach view, measures end-to-end drain latency + main-thread responsiveness in the browser against a stated budget (drain < 25 s, ping < 1 s). Records PASS/FAIL; no xterm.js fallback needed (measured ~6 s drain, 3 ms ping). |
| `read-only-viewer.spec.ts` | [4.3] nx-dwadn | Writer-mutex contention: a 2nd viewer's interact WS is 4009'd -> "Read-only" badge + "input disabled" message, keystrokes do not reach the pane, no crash, read stream stays live. |

### CORS / Tailscale-origin requirement

The agent only honours browser requests from a `100.x.x.x` Origin
(`apps/agent/src/server-origin.ts`). A `localhost`-served page gets a 403 +
"Failed to fetch". The Playwright config therefore serves the web app on the
machine's Tailscale IP (`NEXUS_TS_HOST`, default `100.73.182.4`) and inlines a
matching `NEXT_PUBLIC_NEXUS_AGENT_URL` at build time, so the browser fetch
carries a `100.x` Origin the agent accepts.

### Running

```bash
# Build the web bundle with the agent URL inlined, then run the suite:
NEXUS_ATTACH_SECRET=test pnpm --filter @nexus/e2e test:playwright:full

# Or, if the prod web server is already built/running, just the specs:
NEXUS_ATTACH_SECRET=test pnpm --filter @nexus/e2e test:playwright
```

`NEXUS_TS_HOST` overrides the Tailscale IP; `NEXUS_AGENT_URL` overrides the full
agent base; `POSTGRES_URL` must point at the agent's DB (the harness inserts the
controlled session row there via `psql`).

## Future work

- The Playwright suite uses Chromium only. Add Firefox/WebKit projects if
  cross-browser VT rendering parity becomes a concern.
- Promote a `@visual` subset to `toHaveScreenshot` baselines once a CI runner
  with a pinned Chromium version exists.

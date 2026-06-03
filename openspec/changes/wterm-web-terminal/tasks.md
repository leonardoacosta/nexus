# Tasks: Web terminal — interactive session attach via @wterm/ghostty
<!-- beads:epic:nx-mh68v -->
<!-- beads:feature:nx-5ooc0 -->

## DB Batch

- [x] [1.1] Scaffold `apps/web` (Next.js App Router) into the pnpm/turbo workspace (`pnpm-workspace.yaml`, `turbo.json`); dev server Tailscale-bindable on a non-7400 port; read target agent from `NEXT_PUBLIC_NEXUS_AGENT_URL` [owner:api-engineer] [beads:nx-5mn9b]
- [x] [1.2] Add `@wterm/ghostty` + `@wterm/dom` deps; configure Next.js to serve the committed `ghostty-vt.wasm` (correct MIME); confirm no COOP/COEP headers required [owner:api-engineer] [beads:nx-z2lsi]

## API Batch

- [x] [2.1] Browser agent WS client `apps/web/src/lib/agent-ws-client.ts`: connect `/sessions/:id/stream`; `http->ws`/`https->wss` rewrite; demux binary PTY bytes vs JSON control frames (`geometry`, `replay_done`) [owner:api-engineer] [beads:nx-rnbi9]
- [x] [2.2] Interact channel: open `/sessions/:id/interact`; send stdin binary + `{type:"resize"}` JSON; handle writer-mutex read-only close (code 4009) by marking the session read-only [owner:api-engineer] [beads:nx-pl819]
- [x] [2.3] Reconnect + lifecycle: send `{type:"reconnect",sessionId}` on drop and render the replayed buffer before resuming live; expose connection status (connecting/live/read-only/closed) [owner:api-engineer] [beads:nx-jpxd9]
- [x] [2.4] Session list + create client: `GET /sessions` (list active), `POST /session/start` (spawn project/path), with refresh/poll so the list stays live [owner:api-engineer] [beads:nx-a2ywb]

## UI Batch

- [ ] [3.1] Attach route `apps/web/src/app/attach/[session]/page.tsx`: mount `@wterm/ghostty` core + `@wterm/dom` renderer; load WASM via `fetch` + `instantiate` [owner:ui-engineer] [beads:nx-ubo1s]
- [ ] [3.2] Wire stream -> render: `.bytes` -> `core.writeRaw`; `geometry` -> `core.resize(cols,rows)`; route `core.getResponse()` (DSR/DA) back to `/interact` [owner:ui-engineer] [beads:nx-40vav]
- [ ] [3.3] Wire interactivity: `@wterm/dom` `onData` -> interact stdin; `ResizeObserver` `onResize` -> `{type:"resize"}`; suppress input + resize when read-only [owner:ui-engineer] [beads:nx-g08gz]
- [ ] [3.4] Session entry + chrome: a way to reach `/attach/:session` (id input or link), connection-status UI, Nexus dashboard theme tokens [owner:ui-engineer] [beads:nx-wybls]
- [ ] [3.5] Home/session-list page: render active sessions (from `GET /sessions`) with attach links + a "new session" action; survives page close/reopen (server-persisted) [owner:ui-engineer] [beads:nx-k4u1c]

## E2E Batch

- [ ] [4.1] Playwright: attach to a live session, assert bytes render (expected text appears) and input round-trips (type -> echoed output) [owner:e2e-engineer] [beads:nx-64r21]
- [ ] [4.2] GATE: renderer-throughput spike — stream busy output (`yes` / large `cat`) through `core.writeRaw`, measure frame timing, record pass/fail vs budget and the xterm.js fallback trade-off if it fails [owner:e2e-engineer] [beads:nx-7v884]
- [ ] [4.3] Playwright: read-only path — attach while another writer holds the mutex; assert input disabled and 4009 handled with no error dialog [owner:e2e-engineer] [beads:nx-dwadn]

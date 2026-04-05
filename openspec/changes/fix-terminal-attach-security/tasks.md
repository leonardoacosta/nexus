<!-- beads:epic:TBD -->

## API Batch

- [x] 1.1 [api-engineer] Add `NEXUS_ATTACH_SECRET` env var read at startup; fail-closed if unset (server.ts) — nx-4wn2
- [x] 1.2 [api-engineer] Validate `X-Nexus-Secret` header before WebSocket upgrade on `/stream` and `/interact`; return HTTP 401 on mismatch (server.ts:117-153) — nx-4wn2
- [x] 1.3 [api-engineer] Add `MAX_CONCURRENT_CONNECTIONS` constant (default 50); return HTTP 429 when `allSockets.size >= MAX_CONCURRENT_CONNECTIONS` (server.ts:43) — nx-dtk5
- [x] 1.4 [api-engineer] Call `streamManager.shutdown()` in the `shutdown()` function before `server.stop()` (index.ts:46-53) — nx-acu2
- [x] 1.5 [api-engineer] Add `bufferedAmount` check in `StreamManager.attach` fan-out loop; skip send (and optionally disconnect) slow viewers (stream-manager.ts:33-39) — nx-g7ru
- [x] 1.6 [api-engineer] In pong-timeout handler call `streamManager.removeViewer(ws)` (and `endSession` if no viewers remain) before `ws.close()` (server.ts:52-57) — nx-bg01
- [x] 1.7 [api-engineer] Validate resize cols/rows: reject if not a finite integer in range 1–500 (cols) or 1–300 (rows); send JSON error frame and return (server.ts:333-336) — nx-wjqs
- [x] 1.8 [api-engineer] Validate session ID from URL against `[a-zA-Z0-9_-]+` pattern; return 400 if invalid (server.ts:109-110) — nx-j2ap

## E2E Batch

- [x] 2.1 [e2e-engineer] Test: unauthenticated WebSocket upgrade is rejected with HTTP 401 — nx-4wn2
- [x] 2.2 [e2e-engineer] Test: connection beyond `MAX_CONCURRENT_CONNECTIONS` receives HTTP 429 — nx-dtk5
- [x] 2.3 [e2e-engineer] Test: SIGTERM with active PTY session — process exits cleanly, no zombie children — nx-acu2
- [x] 2.4 [e2e-engineer] Test: resize message with NaN/Infinity/out-of-range values is rejected with error frame — nx-wjqs
- [x] 2.5 [e2e-engineer] Test: pong timeout closes connection and ends session when no viewers remain — nx-bg01
- [x] 2.6 [e2e-engineer] Test: invalid session ID in URL returns 400 — nx-j2ap

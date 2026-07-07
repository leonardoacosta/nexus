# Tasks — add-capture-proxy

## API Batch

- [x] 1.1 Agent route `POST /capture`: body passthrough behind auth middleware, verbatim 4xx/5xx, 504 on timeout (searched: decision route from add-decide-flow-menubar 1.2 is the write-posture exemplar; mirror it)
  - touches: apps/agent/src/routes/capture.ts, apps/agent/src/server-request-handler.ts
- [x] 1.2 Route tests: passthrough, verbatim 400 from gateway, 504 on timeout, auth rejection
  - depends on: 1.1
  - touches: apps/agent/src/routes/capture.test.ts

## E2E Batch

- [x] 2.1 Author docs/capture-shortcut.md: share-sheet + manual invocation recipe, title/url mapping, Tailscale URL + auth header, banner behavior — rebuildable-from-scratch standard
  - depends on: 1.1
  - touches: docs/capture-shortcut.md
- [ ] 2.2 [user] Phone end-to-end: build the Shortcut from the doc, share one page + capture one bare thought, paste created request ids; stop the agent and confirm the failure banner. searched: verification contract is proposal.md ## Testing — no new criteria at run time
  - depends on: 2.1

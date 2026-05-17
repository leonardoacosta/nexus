# Tasks: remove-peer-connector

- [ ] 1.1 `git rm apps/agent/src/services/peer-connector.ts`
- [ ] 1.2 Remove `/ws/federation` route from `server-websocket.ts`
- [ ] 1.3 Drop `source: 'peer' | 'local'` from `LifecycleEnvelope` type in `lifecycle-bus.ts`
- [ ] 1.4 Drop peer-connector init from `apps/agent/src/index.ts`
- [ ] 1.5 Search for any remaining `peer-connector`, `federation`, `source: 'peer'` references and remove
- [ ] 1.6 Update `agents.toml` documentation to clarify it's now client-discovery only
- [ ] 1.7 Run typecheck + tests — green

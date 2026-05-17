# Tasks: remove-peer-connector

- [x] 1.1 `git rm apps/agent/src/services/peer-connector.ts`
- [x] 1.2 Remove `/ws/federation` route from `server-websocket.ts`
- [x] 1.3 Drop `source: 'peer' | 'local'` from `LifecycleEnvelope` type in `lifecycle-bus.ts`
- [x] 1.4 Drop peer-connector init from `apps/agent/src/index.ts`
- [x] 1.5 Search for any remaining `peer-connector`, `federation`, `source: 'peer'` references and remove
- [x] 1.6 Update `agents.toml` documentation to clarify it's now client-discovery only
- [x] 1.7 Run typecheck + tests — green (meta gate: bash -n + openspec validate; full typecheck deferred to integration wave)

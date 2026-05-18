# Tasks: add-schema-drift-detector

- [x] 1.1 Create Drizzle migration for `hook_schema_fingerprints` table
- [x] 1.2 Implement `services/schema-drift.ts` — fingerprint computation + DB lookup + rate-limited emit
- [x] 1.3 Wire detector before dispatch — done via `services/process-hook-event.ts` (nx-oh0j6). Helper invokes `inspectAndEmitDrift(db, eventType, payload)` as step 1 on every event (session_start, agent_spawn, and any future branches), so unknown payload shapes are captured even when the dispatch branch is a no-op. Wired into `dispatcher.ts` session_start + agent_spawn cases. Also unblocked the `@nexus/db` export of `hookSchemaFingerprints` that the detector imports — the table was defined but not re-exported from the package root, which had been blocking the build.
- [x] 1.4 Add `HookSchemaDrift` to the LifecycleEnvelope event union in `lifecycle-bus.ts`
- [x] 1.5 Unit tests: fingerprint determinism, rate-limit window, new-pair emission
- [x] 1.6 Backfill: replay last 7 days of `session_events.metadata` to seed fingerprints

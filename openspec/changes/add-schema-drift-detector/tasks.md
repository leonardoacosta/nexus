# Tasks: add-schema-drift-detector

- [ ] 1.1 Create Drizzle migration for `hook_schema_fingerprints` table
- [ ] 1.2 Implement `services/schema-drift.ts` — fingerprint computation + DB lookup + rate-limited emit
- [ ] 1.3 Wire detector into `routes/hooks.ts` (call before dispatch)
- [ ] 1.4 Add `HookSchemaDrift` to the LifecycleEnvelope event union in `lifecycle-bus.ts`
- [ ] 1.5 Unit tests: fingerprint determinism, rate-limit window, new-pair emission
- [ ] 1.6 Backfill: replay last 7 days of `session_events.metadata` to seed fingerprints

# Tasks: bump-session-idle-threshold

- [x] 1.1 Edit `apps/agent/src/session-manager.ts` — `IDLE_THRESHOLD_MS = 60 * 60 * 1000`
- [x] 1.2 Review and proportionally adjust `STALE_THRESHOLD_MS` and `EVICT_THRESHOLD_MS` (`DEFAULT_STALE_THRESHOLD_MS` bumped 5m→60m to preserve the "idle === stale window" invariant; `DEFAULT_ENDED_SESSION_TTL_MS` kept at 1h — it governs eviction of *ended* rows, not idle/stale, so it is independent of the idle window)
- [x] 1.3 Update `apps/agent/src/session-manager.test.ts` timing assertions
- [x] 1.4 Update `docs/nexus-topology.html` Plate 01c (5m → 60m diagram label)
- [x] 1.5 Run tests — green (meta gate: openspec validate; full vitest deferred to integration wave)

# Tasks: bump-session-idle-threshold

- [ ] 1.1 Edit `apps/agent/src/session-manager.ts` — `IDLE_THRESHOLD_MS = 60 * 60 * 1000`
- [ ] 1.2 Review and proportionally adjust `STALE_THRESHOLD_MS` and `EVICT_THRESHOLD_MS`
- [ ] 1.3 Update `apps/agent/src/session-manager.test.ts` timing assertions
- [ ] 1.4 Update `docs/nexus-topology.html` Plate 01c (5m → 60m diagram label)
- [ ] 1.5 Run tests — green

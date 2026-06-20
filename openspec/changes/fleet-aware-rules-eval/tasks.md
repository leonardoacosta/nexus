<!-- beads:epic:nx-i4sp1 -->
<!-- beads:feature:nx-6wikt -->

# Tasks — Fleet-Aware Rules Evaluation (Phase 1.7)

## DB Batch

- [ ] Add a `vector` jsonb column to `packages/db/src/schema/fleetPresence.ts` (`jsonb("vector").$type<PresenceVector>()`, nullable for back-compat) holding the full per-machine presence vector; keep the existing typed columns [beads:nx-i6adc]
- [ ] Run `pnpm --filter @nexus/db db:push` against `POSTGRES_URL`, verify the column exists, and handle the drizzle snapshot guard if it trips (no hand-written `.ts` migration) [beads:nx-hkbw6]

## API Batch

- [ ] Refactor `apps/agent/src/notifications/presence-context.ts` from a single merged vector to a per-machine vector map (`machine -> PresenceVector`, each field TTL'd); the report's `macHost` is the machine key, falling back to the local machine name when absent; keep the existing local-machine vector accessor for the manager's fallback [beads:nx-694l4]
- [ ] On each report + heartbeat tick, upsert the reporting machine's FULL vector to `fleet_presence` (write `vector` jsonb + `on_console` + `mac_active`/`mac_locked` + `heartbeat` together from the same per-machine vector so typed columns and jsonb cannot diverge) — this fixes nx-vbv39 (remote reports persist per-machine rows) [beads:nx-x0wek]
- [ ] Add `resolveLiveConsoleVector(db, ttlMs)` to `apps/agent/src/services/fleet-presence.ts` — select the newest `on_console` row within the heartbeat TTL, deserialize its `vector` jsonb to a `PresenceVector`, return it or null; reuse the existing `resolveLiveConsole` machine-resolution logic [beads:nx-2w918]
- [ ] Update `apps/agent/src/routes/presence-report.ts` to key the merge by the reporting machine and trigger the per-machine fleet upsert (machine identity from `macHost`, fallback to local) [beads:nx-cmm99]
- [ ] Update `apps/agent/src/notifications/manager.ts` to evaluate against the resolved live-console vector: `const v = (await resolveLiveConsoleVector(db)) ?? localVector; decidePresenceRoute(flag, v)`; preserve the all-unknown→legacy guard and single-machine no-regression (rule set + `evaluateRules` untouched) [beads:nx-omb5h]
- [ ] Enrich `apps/agent/src/routes/presence-fleet.ts` (`GET /presence/fleet`) to include the resolved live-console machine's vector alongside the machine list + `liveConsole` [beads:nx-yc9dg]

## E2E Batch

- [ ] Extend `apps/agent/src/services/fleet-presence.test.ts` — `resolveLiveConsoleVector`: newest on-console vector wins, no on-console → null, stale-past-TTL → null, jsonb round-trips to a PresenceVector [beads:nx-x8djj]
- [ ] Extend `apps/agent/src/notifications/presence-context.test.ts` — per-machine map keying, remote report writes a per-machine fleet row (nx-vbv39 regression), local self-row still written, per-field TTL per machine [beads:nx-m9y1z]
- [ ] Extend `apps/agent/src/notifications/manager-presence.test.ts` — fleet-aware eval: a session on a headless local vector + a live-console Mac (macActive) fires Rule 1; no live console + all-unknown local → legacy fallback; single-machine fleet unchanged [beads:nx-u4r9x]
- [ ] Extend `apps/agent/src/routes/presence-report.test.ts` — report keyed by macHost merges into the right machine; fleet row carries the full vector jsonb; missing macHost falls back to local machine [beads:nx-05db8]

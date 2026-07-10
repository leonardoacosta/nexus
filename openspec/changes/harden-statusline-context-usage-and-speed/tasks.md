<!-- beads:epic:nx-4n8co -->
<!-- beads:feature:nx-hftkf -->

# Tasks — harden-statusline-context-usage-and-speed

## UI Batch

- [ ] 1.1 Extend `CcInput.rate_limits.five_hour` to `{ used_percentage?: number; resets_at?: number }` in `apps/nexus-statusline/src/index.ts` (seven_day already carries `used_percentage`). [beads:nx-tj2lb]
- [ ] 1.2 Add `getBarWidth()` (reads `process.env.COLUMNS` → `process.stdout.columns`; buckets ≥100→10, ≥60→6, else 4; default 10) and switch `renderGauge` from the hardcoded `7` to `getBarWidth()`, recomputing `filled`/`empty` against the resolved width. Export for tests. [beads:nx-qh059]
- [ ] 1.3 Add a per-session context-guard resolver (last-good snapshot at `~/.claude/scripts/state/statusline-ctx.<session_id>.json`): on `used_percentage === 0`/absent restore a fresh snapshot else omit the segment; on `> 0` refresh (3s write-throttle). Atomic tmp+rename, `mode 0o600`, fail-soft. Wire it into `main()` before `renderContext`. Export the resolver for tests. [beads:nx-w2dc9]
- [ ] 1.4 Add a stdin-usage builder: when both `rate_limits.{five_hour,seven_day}.used_percentage` are present, build the `UsageResponse` from stdin and skip `getApiUsage()` + `readAccessToken()`; otherwise fall back to `getApiUsage()`. Gate the fetch in `main()`. Export the builder for tests. [beads:nx-s0bua]
- [ ] 1.5 Add `getSpeed(transcriptPath, sessionId)` (stat-only byte-growth, per-session cache at `~/.claude/scripts/state/statusline-speed.<session_id>.json`, guards `SPEED_WINDOW_MS=2000`/`MIN_DELTA_MS=500`, `bytes/4`) and render a DIM `≈{n}t/s` segment near the context bar when non-null. Atomic write, fail-soft. Export for tests. [beads:nx-6e622]
- [ ] 1.6 Unit tests in `apps/nexus-statusline/src/index.test.ts` (`bun test`): context guard (zero+cache → restored value not 100%; zero+no-cache → segment omitted; non-zero → cache refreshed), stdin-usage (present → no API call via injected spy; absent → falls back), speed (in-window delta → segment; stale/too-short/non-positive → null), bar width (COLUMNS=120→10, COLUMNS=50→4, unset→10). [beads:nx-7ohy2]
- [ ] 1.7 Run gates from repo root and paste output: `pnpm --filter @nexus/statusline typecheck` and `bun test apps/nexus-statusline/src/index.test.ts`. Both MUST pass. [beads:nx-voxi5]

## E2E Batch

- [ ] 2.1 Runtime evidence via `bun run apps/nexus-statusline/src/index.ts` — paste each stdout render proving the four `## Testing` runtime cases: (a) forced `used_percentage:0` + seeded snapshot → restored CTX, never `CTX 100%`; (b) stdin `rate_limits.*.used_percentage` → 5H/7D gauges, no OAuth call; (c) growing transcript → `≈Nt/s` segment; (d) `COLUMNS=120` vs `50` → 10- vs 4-cell bars. [beads:nx-grvjc]

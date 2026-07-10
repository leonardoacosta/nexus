# Design — statusline context guard, stdin usage, speed, adaptive bars

All four changes live in the single Bun binary `apps/nexus-statusline/src/index.ts`, which CC
invokes on every statusline refresh (~300ms). Every added path is fail-soft (returns
null/omits its segment on any error) — the statusline must never crash. Pure functions take
injected deps so `index.test.ts` stays deterministic (mirrors the existing `renderStatusline`
+ `RenderDeps` seam).

## 1. Suspicious-zero context guard

**Signal nx actually has.** nx's stdin `context_window` carries only `used_percentage` +
`context_window_size` — NOT claude-hud's `current_usage` token breakdown. So nx cannot reuse
`isAllUsageZero(current_usage)`, and it deliberately does not parse the transcript for
`compact_boundary`.

**Why a simpler heuristic is correct here.** CC reports a genuine post-`/compact` reset as a
*non-zero* percentage (the post-compact system-prompt + summary tokens, typically ~30–40%), and a
fresh session's first populated frame is likewise non-zero. A literal `used_percentage === 0` is
therefore reliably either the documented reporting glitch or a pre-population frame — never a real
"context is empty" state worth rendering as `100% remaining`.

**Mechanism.** Per-session last-good snapshot at
`~/.claude/scripts/state/statusline-ctx.<session_id>.json` = `{ used_percentage, context_window_size, saved_at }`.

- On a frame with `used_percentage > 0`: refresh the snapshot (throttled — skip the rewrite if the
  file's mtime is < 3s old, matching claude-hud's `WRITE_TTL_MS`). Render normally.
- On `used_percentage === 0` (or absent): read the snapshot. If present and fresh (`saved_at` within
  a 10-min freshness window), render the snapshot's value. If absent/stale, **omit** the context
  segment for that render (never render a synthesized 0%/100%).
- Missing `session_id` → no snapshot key → treat as fresh (omit on zero). Atomic tmp+rename write,
  `mode 0o600`, all fs wrapped.

This keys off `session_id` (already on stdin), so concurrent CC windows never share a snapshot.

## 2. Prefer stdin usage, fall back to OAuth API

**Type fix.** Extend `CcInput.rate_limits.five_hour` from `{ resets_at? }` to
`{ used_percentage?, resets_at? }` (the `statusline-renderer` spec already declares this shape;
the code lagged).

**Precedence in `main()`.** Build a `UsageResponse` from stdin when BOTH windows' `used_percentage`
are present:
`{ five_hour: { utilization: used_percentage, resets_at: <from unix secs> }, seven_day: {...} }`.
When stdin supplies it, do NOT call `getApiUsage()` and do NOT call `readAccessToken()` — the
network call + credential read are skipped entirely. When stdin lacks either window's
`used_percentage`, fall back to `getApiUsage()` exactly as today. `getApiUsage`/`readAccessToken`
stay in the file for the fallback path (Bedrock/Vertex, older CC) — this is prefer-stdin, not
delete-API. Momentum projection (`projectUtilization`) already works off a point utilization value,
so nothing is lost by dropping the API in the common case.

## 3. tokens/sec via transcript byte-growth (stat-only)

`getSpeed(transcriptPath, sessionId)` → number | null. Per-session cache
`~/.claude/scripts/state/statusline-speed.<session_id>.json` = `{ fileSize, timestamp }`.

- `statSync(transcriptPath).size` — a stat, never a read/parse (this is the first transcript touch
  in the binary; it stays O(1)).
- Guards (verbatim intent from claude-hud `speed-tracker.ts`): counter/file shrink → reset cache,
  return null; `deltaMs > SPEED_WINDOW_MS` (2000) → stale, reset, null; `deltaMs < MIN_DELTA_MS`
  (500) → too soon, keep cache, null; `deltaBytes <= 0` → null.
- `estimatedTokens = deltaBytes / 4`; `speed = estimatedTokens / (deltaMs / 1000)`.
- Render a DIM `≈{round(speed)}t/s` segment near the context bar when non-null. Atomic write, fail-soft.

The `≈` prefix signals the estimate is heuristic (byte-growth, not true output tokens). On a
statusline that refreshes only between turns the segment is often absent (no delta) — that is fine,
it is a live-throughput hint, not a guaranteed field.

## 4. Adaptive bar width

`getBarWidth()`: read `process.env.COLUMNS` first (integer parse), then `process.stdout.columns`
(and `process.stderr.columns`); bucket `≥100→10`, `≥60→6`, else `4`; default `10` when width is
unknown (mirrors claude-hud `getAdaptiveBarWidth`). `renderGauge` replaces its hardcoded `7` with
`getBarWidth()` and recomputes `filled = floor(pct * width / 100)`, `empty = width - filled`. Bar
glyphs (`═`/`─`) and threshold colors are unchanged — only the cell count adapts.

## Test seams

`getBarWidth`, `getSpeed`, the context-guard resolver, and the stdin-usage builder are each pure
(or dep-injected: cache-read/write, `statSync`, `now`, `columns` source) and exported for
`index.test.ts`, matching how `modelEffortToken` / `renderStatusline` are already tested. No change
to the network/git seams beyond gating `getApiUsage` behind the stdin-usage check.

# Harden statusline: context guard, stdin usage source, live speed, adaptive bars

## Why

Recon of `jarrodwatts/claude-hud` (docs/recon/jarrodwatts-claude-hud.md) surfaced four gaps in
`nexus-statusline`, which today trusts CC's stdin fields wholesale and renders fixed-width bars:

1. **Inverted context reading (correctness bug).** `index.ts` reads `context_window.used_percentage`
   raw. On CC's intermittent spurious `used_percentage: 0` frame it computes `remaining = 100 - 0`
   and renders **`CTX 100%`** — the opposite of the truth, exactly when context is actually full.
2. **Redundant network + credential read for usage.** nx fetches 5h/7d utilization from the
   authenticated Anthropic OAuth Usage API every render (cached 5 min), while CC now supplies
   `rate_limits.{five_hour,seven_day}.used_percentage` directly on stdin (v2.1.6+). The existing
   `statusline-renderer` spec already documents `five_hour.used_percentage` in the payload type,
   but the code never reads it — a spec/code drift.
3. **No live throughput signal.** No tokens/sec indicator.
4. **Fixed 7-cell bars.** `renderGauge` hardcodes a 7-cell bar regardless of terminal width;
   wide terminals under-use space and narrow ones wrap the multi-segment head mid-segment.

## What Changes

- **Context guard (correctness):** treat `context_window.used_percentage === 0` as *unpopulated*,
  not zero. Restore a per-session last-good snapshot when one exists; otherwise omit the context
  segment for that render. Never render the inverted `CTX 100%`. nx's heuristic is simpler than
  claude-hud's (no transcript-parse for `compact_boundary`) and correct because CC reports a real
  post-`/compact` reset as a *non-zero* percentage — so a literal `0` is reliably the glitch or a
  pre-population frame. See design.md.
- **Prefer stdin for usage, keep API fallback:** when `rate_limits.*.used_percentage` is present on
  stdin, build the usage display from it and **skip** the OAuth Usage-API fetch + credential read.
  Fall back to `getApiUsage()` only when stdin lacks the fields (older CC, Bedrock/Vertex).
- **Live tokens/sec via transcript byte-growth:** a stat-only speed estimate — `statSync(transcript_path).size`
  delta over a per-session speed cache, `≈bytes/4` tokens, with the same noise guards claude-hud
  uses (`SPEED_WINDOW_MS`, `MIN_DELTA_MS`). No JSON parse; the transcript is stat'd, never read.
- **Adaptive bar width:** `getBarWidth()` from `COLUMNS` → `process.stdout.columns` (≥100→10,
  ≥60→6, else 4), replacing the hardcoded 7 in `renderGauge`.

## Context

- touches: `apps/nexus-statusline/src/index.ts`, `apps/nexus-statusline/src/index.test.ts`

No soft dependencies: the only in-flight epic (`context-aware-routing`) does not touch the
statusline binary, and no in-progress proposal writes `apps/nexus-statusline/**`.

## Testing

- **Unit** (`apps/nexus-statusline/src/index.test.ts`, `bun test`):
  - Context guard: `used_percentage: 0` with a cached non-zero last-good renders the cached value
    (NOT 100% remaining); `0` with no cache omits the context segment; a non-zero frame refreshes
    the snapshot.
  - Usage source: stdin carrying `five_hour.used_percentage` renders the 5H/7D gauges without an
    API fetch; stdin lacking them falls back to the injected `getApiUsage` result.
  - Speed: a byte-growth delta inside the window renders a `tok/s` segment; a delta that is stale
    (`> SPEED_WINDOW_MS`), too fresh (`< MIN_DELTA_MS`), or non-positive renders no segment.
  - Bar width: `COLUMNS=120` → 10-cell bar; `COLUMNS=50` → 4-cell bar; unset → 10 default.
- **Runtime evidence:** live render via `echo '<payload>' | bun run apps/nexus-statusline/src/index.ts`
  paste showing (a) a forced `used_percentage: 0` frame rendering a restored context value rather
  than `CTX 100%`, (b) usage gauges sourced from stdin with no network call, (c) a `tok/s` segment
  on a growing transcript, and (d) bar width changing with `COLUMNS`.

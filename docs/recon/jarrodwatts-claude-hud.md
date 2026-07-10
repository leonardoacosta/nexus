# Repo Context: jarrodwatts/claude-hud

> Source: https://github.com/jarrodwatts/claude-hud
> Context: project (nx)   ·   Stars: 26,300   ·   Last push: 2026-07-04   ·   License: MIT (permissive — verbatim steal allowed)
> Ask: none — general sweep

## Ask
No rider supplied. Run is a general adoption sweep with an implicit focus on nx's own
statusline (`apps/nexus-statusline`), the direct analogue.

## Purpose
Claude Code statusline HUD plugin: parses the CC stdin JSON payload **plus the transcript
JSONL** every ~300ms to render context health, live tool activity, running-subagent status,
todo progress, tokens/sec, and 5h/7d usage windows — all in the native statusline (no window,
no tmux).

## Architecture & Key Patterns
`CC stdin JSON → claude-hud → stdout`, with a side-channel read of `transcript_path` (JSONL).
Every hot-path decision is shaped by the 300ms re-run budget:

- **Transcript parse** (`src/transcript.ts`, 24KB): streaming `readline` over
  `createReadStream` (never `readFileSync`), single-pass state machine into `Map`/`Set`,
  per-line `try/catch` skips malformed lines. Tool activity = correlate `tool_use.id` ↔
  `tool_result.tool_use_id`; subagents = `Task`/`Agent` blocks keyed by id, with
  `run_in_background` special-cased (background elapsed time comes from a separate
  `queue-operation`/`enqueue` entry, because the parent `tool_result` timestamp is written at
  *launch*, not completion); todos = three tool schemas (`TodoWrite`/`TaskCreate`/`TaskUpdate`)
  reconciled to one list.
- **Cache-to-stay-fast** (`transcript.ts`, `context-cache.ts`, `speed-tracker.ts`): cache file
  = `sha256(resolved transcript path)` (per-session isolation across concurrent CC windows);
  validity = versioned `mtime + size` sentinel (never content-hash the big file); write only on
  clean parse; ISO date round-trip; write-throttle tied to the 300ms cadence (`WRITE_TTL_MS=3s`,
  usage snapshot `30s`); atomic `tmp + rename`, `mode 0o600`; probabilistic 1% GC sweep.
- **Context %** (`stdin.ts`, `context-cache.ts`): prefer CC-native `used_percentage`, treat
  **0 as "not populated"**; `applyContextWindowFallback` restores a last-good snapshot on a
  suspicious-zero frame (empty `current_usage`), and distinguishes a real post-`/compact` reset
  from a glitch via the transcript's `compact_boundary` timestamp.
- **Width-correct render** (`render/width.ts`, `render/index.ts`, `render/colors.ts`):
  adaptive bar width bucketed by terminal `COLUMNS` (≥100→10, ≥60→6, else 4); `Intl.Segmenter`
  grapheme + ANSI-escape-aware visual width; East-Asian-Ambiguous glyphs (`─│█░◐▸⚠✓`) counted
  as width 2 only in CJK locale; OSC-8 hyperlink close on mid-link truncation.

## Findings

nx already owns the hard capability claude-hud's transcript parser exists to provide — live
tool / subagent / todo tracking — but through a **strictly better source for nx's model**: the
agent daemon ingests CC hooks over a socket and persists a subagent tree
(`0029_add_subagent_tree_columns`, `apps/agent/src/scripts/backfill-subagent-tree.ts`), fanned
out to multi-machine Swift dashboards. So the transcript-polling mechanism is a **Skip** (nx has
a better-owned source), and the value here is two small, concrete correctness/polish fixes to
nx's own statusline binary, which trusts CC's stdin fields wholesale.

---

### ADAPT 1 — Suspicious-zero context-window guard (headline)

**Coverage: NONE** (searched: `rg -in "suspicious|used_percentage|current_usage|last.?good|fallback" apps/nexus-statusline/src/` — only the raw read at `index.ts:1083` and test fixtures; no glitch guard).

Source: `src/context-cache.ts` `isSuspiciousZero` + `applyContextWindowFallback`; `src/stdin.ts` `getNativePercent` (treats `0` as unpopulated).

- **Before:** `apps/nexus-statusline/src/index.ts:1083` reads `context_window.used_percentage`
  directly. On CC's intermittent spurious `used_percentage: 0` frame (empty `current_usage`),
  nx computes `remaining = 100 - 0` and renders **`CTX 100%`** — the opposite of the truth,
  right when context is actually full.
- **After:** guard the read: a `used_percentage === 0` frame with no corroborating usage/cost
  signal restores the last-good value from a tiny per-session cache
  (`~/.claude/scripts/state/ctx-lastgood.<session_id>.json`), unless a newer transcript
  `compact_boundary` marks a real `/compact` reset (then keep the zero).
- **Expected gain:** eliminates a visible, misleading 100%-context reading. Correctness.
- **Effort:** small–medium (guard + ~30-line cache helper modeled on nx's existing
  `readCachedAgentJson`).
- **Files:** `apps/nexus-statusline/src/index.ts` (+ its `index.test.ts`).

**Placement Verdict**

| # | Row | Verdict |
|---|-----|---------|
| 1 | Layer | Code change in the statusline **execution binary** (`@nexus/statusline`) — not a script/skill/command. |
| 2 | Landing path | `apps/nexus-statusline/src/index.ts` — guard inside `main()` before `renderContext` (line ~1083) + a `readCtxLastGood()/writeCtxLastGood()` helper pair. |
| 3 | Extend-before-create | Extend existing `renderContext` + `main`; model the cache on the in-file `readCachedAgentJson`/`getRoadmapPulse` stale-cache idiom. No new module, no new file. |
| 4 | Standalone vs facet | Facet of the existing render path — inline helpers in the same file. |
| 5 | Scope | nx-local: nx owns the statusline binary. It IS Leo's active statusline for **every** project (reads `roadmap-pulse` for any cwd), so the fix benefits the whole fleet, but the code home is nx. NOT a cc-global artifact (cc's statusline path is separate/superseded). |
| 6 | Tracked medium | `apps/nexus-statusline/src/index.ts` → `git ls-files -s` = `100644 4b7a5b48… 0`. Tracked. Cache file lives under `~/.claude/scripts/state/` (nx's existing runtime-cache convention, not committed). |
| 7 | Gitignore hazard | None — src already tracked; cache path is runtime state, never staged. No `git add -f`. |
| 8 | Description class | n/a (code change, no skill/description). |
| 9 | Wiring sites | n/a — lives in the always-run render path; no trigger pointer. |
| 10 | Caller + cadence | The `nexus-statusline` binary itself, **every prompt render** (~300ms cadence). Definite, high-frequency caller. |
| 11 | Fleet propagation | n/a — single-repo binary. |

---

### ADAPT 2 — Adaptive bar width by terminal COLUMNS

**Coverage: NONE** (searched: `rg -in "columns|COLUMNS|adaptive|terminal.?width|barWidth" apps/nexus-statusline/src/ packages/` — no width awareness anywhere).

Source: `src/utils/terminal.ts` `getAdaptiveBarWidth`, `src/render/colors.ts` `coloredBar`.

- **Before:** `renderGauge` (`apps/nexus-statusline/src/index.ts:855`) hardcodes a **7-cell**
  `═/─` bar regardless of terminal width. On wide terminals the multi-gauge line under-uses
  space; on narrow ones the whole multi-segment head (`◉ @dom  proj  $x  ⧗…  CTX…  5H…  7D…`)
  wraps mid-segment with no truncation.
- **After:** compute bar width from terminal columns (env `COLUMNS` → `process.stdout.columns`
  fallback), bucketed like claude-hud (`≥100→10, ≥60→6, else 4`). Optionally truncate the head
  to width when columns are known.
- **Expected gain:** legible bars on wide terminals, no ragged wrap on narrow ones.
- **Effort:** small (bar-width helper). The full grapheme/ANSI width engine is **not** adopted
  (see Monitor below) — bar sizing only.
- **Files:** `apps/nexus-statusline/src/index.ts`.

**Placement Verdict**

| # | Row | Verdict |
|---|-----|---------|
| 1 | Layer | Code change in the statusline execution binary. |
| 2 | Landing path | `apps/nexus-statusline/src/index.ts` — a `getBarWidth()` helper feeding `renderGauge` (replace the hardcoded `7`). |
| 3 | Extend-before-create | Extend `renderGauge`; it already takes `pct`+`suffix`, only the cell count is fixed. No new artifact. |
| 4 | Standalone vs facet | Facet — one helper in the same file. |
| 5 | Scope | nx-local (same reasoning as Adapt 1). |
| 6 | Tracked medium | `apps/nexus-statusline/src/index.ts` mode `100644` (tracked, evidence above). |
| 7 | Gitignore hazard | None. |
| 8 | Description class | n/a. |
| 9 | Wiring sites | n/a — render path. |
| 10 | Caller + cadence | `nexus-statusline` binary, every render. |
| 11 | Fleet propagation | n/a — single-repo. |

---

### MONITOR 3 — `rate_limits.*.used_percentage` direct from CC stdin

**Coverage: PARTIAL** — nx owns usage via an authenticated Anthropic OAuth call
(`getApiUsage`, `index.ts:428`) cached 5min; its stdin `five_hour` type carries only
`resets_at` (`index.ts:39,90`), never `used_percentage`.

claude-hud shows CC now supplies `rate_limits.five_hour.used_percentage` +
`seven_day.used_percentage` directly in stdin (v2.1.6+, `src/stdin.ts getUsageFromStdin`). nx
could read those and **drop the OAuth token read + network fetch** for at least the 7-day
window. Not actioned now: nx's momentum projection (`projectUtilization`) wants utilization
history, and this rewires a working, credential-gated path — a deliberate decision, not a
drive-by. Revisit if the OAuth usage endpoint churns or the per-render latency matters.

### MONITOR 4 — tokens/sec speed line

**Coverage: NONE** — no speed tracking in nx (`rg` clean). claude-hud's two-tier estimator
(`src/speed-tracker.ts`: `output_tokens` delta, byte-growth fallback, `SPEED_WINDOW_MS=2000` /
`MIN_DELTA_MS=500` noise guards) is clean, but **no caller**: nx's statusline is roadmap-focused
and deliberately never parses the transcript. Adding it would mean introducing transcript reads
to a binary that has none. No named caller → ceiling is Monitor.

### SKIP 5 — Transcript JSONL tool / subagent / todo parsing

**Coverage: FULL** — `apps/agent/src` (hook-ingest socket spine → dispatcher →
`0029_add_subagent_tree_columns`, `backfill-subagent-tree.ts`, `session-cost-read.ts`). nx's
daemon ingests live CC hooks and persists a subagent tree fanned out to Swift dashboards — a
strictly better source than polling `transcript_path` for nx's peer-to-peer model. The parser is
elegant but nx already owns the capability through better-fitting infrastructure.

### SKIP 6 — Session-token accumulation + cost regex fallback

**Coverage: FULL** — nx renders CC-native `cost.total_cost_usd` directly (`index.ts:1014`) and
never accumulates tokens or estimates cost. claude-hud's dual-log dedupe + ordered-regex pricing
table (`src/cost.ts`) exist only to reconstruct what CC already hands nx natively.

### SKIP 7 — Plugin-marketplace distribution (`.claude-plugin/marketplace.json`)

**Coverage: n/a** — claude-hud ships as an installable CC plugin; nx's statusline is a
`bun build --compile` binary deployed via systemd/launchd. Different distribution model, no
overlap.

## Prior Coverage
None found for `jarrodwatts-claude-hud` (no prior `docs/recon/*claude-hud*`, no archived spec,
no beads). Prior recon in `docs/recon/` covers a different target (`beadboard` / beads tracker).

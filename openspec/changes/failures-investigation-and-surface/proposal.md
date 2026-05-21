---
status: draft
---

# Proposal: failures-investigation-and-surface

## Why

The Swift dashboard's Failures tab is empty in production. Investigation
revealed the **root cause is not a query bug — it's that the Bun spine
never reimplemented the endpoint**:

```ts
// apps/agent/src/routes/failures-route.ts line 79
// "The failure buffer is backed by the Rust agent's SQLite. The live
//  aggregate isn't wired into the Bun spine yet — return a stub..."
return new Response(JSON.stringify({
  total: 0,
  by_tool: {},
  by_project: {},
  top_errors: [],
  trend: { current: 0, previous: 0, direction: "flat" },
}), ...);
```

Meanwhile, real failure data IS being captured — but in two
disconnected places:

1. **`~/.claude/scripts/state/failures/*.jsonl`** — one file per day,
   one JSON object per line, capturing CC tool failures (Read/Bash/etc.):
   `{ timestamp, tool_name, error_snippet, command_snippet, project, session_id }`.
   Pruned by the existing cron service at 30 days.
2. **`script_errors` table** (Postgres) — pino warn/error/fatal log
   entries from the agent itself (operational errors, not user-session
   tool failures). Written by `withErrorCapture()` and pino-db-transport.
   Different shape, different consumer.

The `/failures` endpoint's documented row shape (`tool`, `project`,
`message`, `stack`, `trace_id`, `stack_truncated`) maps cleanly onto
the JSONL source. The script_errors table is a separate concern
(operational observability) and is out of scope for this proposal.

The UX work is small — the existing `FailuresView` already handles
empty-state, day-window picker (1d/7d/30d), expandable rows, and a
refresh button. It just needs real data flowing in.

## What Changes

1. **JSONL ingester service** — new
   `apps/agent/src/services/cc-failures-ingester.ts` reads
   `~/.claude/scripts/state/failures/*.jsonl` for the requested day
   window. Streams line-by-line via `Bun.file().stream()` to avoid
   loading multi-MB files into memory. Cache the parsed result per
   `(days)` arg with a 60-second TTL.

2. **/failures handler rewrite** — `handleFailures` in
   `apps/agent/src/routes/failures-route.ts` consumes the ingester and
   builds the aggregate shape: `total`, `by_tool` (`{ Read: 12, Bash: 5 }`),
   `by_project` (`{ nx: 8, oo: 9 }`), `top_errors[]` (count-sorted by
   stack fingerprint, top 20), and `trend` (current vs previous
   day-window comparison). Keeps the exact response contract documented
   in `agent-payload-completeness`, including the `trace_id` and
   `stack_truncated` row fields (both null/false for JSONL-sourced rows
   since the JSONL schema doesn't carry them yet).

3. **Trend computation** — `current` = sum over [now - days, now],
   `previous` = sum over [now - 2*days, now - days], `direction` =
   `"up" | "down" | "flat"` based on >10% deltas. Single pass over
   the JSONL files keyed by date.

4. **Aggregate fingerprinting** — `top_errors[]` rows are deduped by
   stable fingerprint = `sha256(tool_name + error_snippet[:200])`. The
   `count` field is the dedup multiplicity. The first occurrence's
   `command_snippet` is preserved verbatim as `command`. This matches
   the existing wire-shape consumed by `FailuresView`.

5. **Source-of-truth label** — response gains a `source: "jsonl"`
   field so the dashboard can show provenance. When a future spec
   migrates ingestion to a DB table, the field flips to `"db"`. The
   Swift `FailureSummary` decoder accepts an optional `source` string;
   missing decodes as `nil` for back-compat.

6. **FailuresView micro-fixes** — three small UX tightenings to make
   the populated view useful:
   - Empty-state copy: when `total > 0` but the user's filter
     (project / tool) yielded zero, show "No failures match this filter"
     rather than the global "No failures" message.
   - Tool / project filter chips: tap a `by_tool` or `by_project` key
     in a summary strip atop the list to filter `top_errors` client-side.
   - Trend indicator: render `↑12% / ↓5% / —` next to the FAILURES
     header chip when `trend.direction != "flat"`.

## Context

- depends on: 
- touches: `apps/agent/src/services/cc-failures-ingester.ts`, `apps/agent/src/services/cc-failures-ingester.test.ts`, `apps/agent/src/routes/failures-route.ts`, `apps/agent/src/routes/failures-route.test.ts`, `apps/swift/NexusShared/Models/FailureSummary.swift`, `apps/swift/nexus-mac/Sources/Dashboard/FailuresView.swift`

No conflict with the two specs scaffolded earlier this session
(`specs-tab-start-on-spec`, `projects-tab-accordion-deeplink`) — they
touch SpecsView / ProjectsView / NexusClient / NexusAggregateClient
and entirely different agent routes. This spec touches `failures-route.ts`
and `FailuresView.swift` only.

The `agent-payload-completeness` spec (archived earlier this month)
pinned the response shape. This proposal preserves that contract
verbatim — the change is purely the data-fetching backend.

## Risk

- **JSONL file growth.** A single day's file in active use can reach
  ~100KB-1MB. Reading 30 days = up to 30MB. Mitigation: streaming
  parse via `Bun.file().stream()` + line-by-line `JSON.parse`. Memory
  ceiling is bounded by the aggregate result size, not the file size.
  Hard cap: refuse `days > 90`; return 400 with "max window is 90 days".
- **Malformed JSONL lines.** Old files may have lines truncated by
  earlier crashes. Mitigation: `try { JSON.parse(line) } catch` per
  line, increment a `parse_errors` counter, never throw. Counter is
  added to the response so the dashboard can surface the count
  ("12 lines unparseable") without exposing the actual content.
- **Cross-agent failures missing.** The current JSONL files are
  per-machine. The Swift dashboard's aggregate client fans out across
  agents, so `/failures` is naturally per-agent and aggregated by the
  client. No new work here — same fan-out pattern the existing
  endpoints use.
- **Stack truncation already-set.** The JSONL schema's
  `error_snippet` is already truncated upstream (by whatever writes
  the JSONL). We map it to `message` (truncated) and emit
  `stack: null` + `stack_truncated: false` since no real stack
  exists in the JSONL. This matches the documented contract — the
  STACK_TRUNCATE_BYTES flag is only meaningful when a full stack is
  available.

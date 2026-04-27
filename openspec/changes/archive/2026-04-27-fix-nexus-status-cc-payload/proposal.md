# fix-nexus-status-cc-payload — Change Proposal

## Summary

Fix the `nexus-status` statusline binary so it (a) reads the correct field name CC actually sends for context window usage, and (b) consumes the full CC statusline payload instead of re-querying nexus-agent for data CC already provides. The current implementation reads `context_window.remaining_percentage` — a field CC has never sent — so the context bar silently never renders. It also ignores `cost.*`, `rate_limits.five_hour.resets_at`, `workspace.project_dir`, `output_style`, and `session_id`, preferring to compute substitutes via `git` subprocesses and agent-analytics DB queries. Result: a statusline that LOOKS rich (progress bars for 5H / 7D rate limits) but is reading stale data and missing the one number most developers check the statusline for.

## Motivation

**Observed (2026-04-24):** During the notification-pipeline audit, a parallel review of the statusline surfaced multiple defects:

1. **Context bar never renders.** `src/index.ts:35` declares `context_window?: { remaining_percentage?: number }` as the CC input shape. CC actually sends `context_window.used_percentage` (plus `used_tokens` and `max_tokens`) per [code.claude.com/docs/en/statusline](https://code.claude.com/docs/en/statusline). The guard `if (remaining != null)` always short-circuits. Users have no visibility into context fill % on the statusline despite the code appearing to render one.
2. **Re-querying for data CC already provides.** The 5H / 7D rate-limit segments are computed by HTTP-calling `nexus-agent`'s analytics DB instead of consuming `rate_limits.five_hour.resets_at` which CC has sent since v1.2.80. This costs two subprocess/network calls per statusline render (~300 ms cadence) and produces numbers that can diverge from `/cost` and `/usage`.
3. **`git` subprocess per render.** Project resolution runs `git branch --show-current` + `git remote get-url origin` to derive the project name, when `workspace.project_dir` is already in the payload. 300 ms render interval × 2 subprocess calls = 6 extra fork/exec per second sustained while any CC session is active.
4. **Silent omission of high-signal fields.** `cost.total_cost_usd`, `cost.total_lines_added`, `cost.total_lines_removed`, `cost.total_duration_ms`, `output_style`, `session_id`, and `version` all arrive on stdin and are discarded. Community statuslines ([vientapps](https://vientapps.com/blog/building-a-claude-code-statusline/), [sirmalloc/ccstatusline](https://github.com/sirmalloc/ccstatusline)) have adopted this data as primary; ours shows none of it.

**Why this matters now:** The 2026-04-24 telemetry audit revealed that multiple cc-side surfaces (statusline, notifications, telemetry) were quietly wrong in production. The notification and telemetry paths have been fixed. The statusline is the last of the trio. It is the most visually-present CC integration (rendered every ~300 ms) and the most user-facing — fixing it closes the loop on "what the user sees continuously is actually correct."

**Latest CC payload (per official docs, 2026-04-24):**

```jsonc
{
  "hook_event_name": "StatusLine",
  "session_id": "<uuid>",
  "transcript_path": "<path to .jsonl>",
  "cwd": "<current dir>",
  "model": { "id": "claude-opus-4-7", "display_name": "Opus 4.7" },
  "workspace": { "current_dir": "...", "project_dir": "..." },
  "version": "2.1.119",
  "output_style": "tts-summary",
  "cost": {
    "total_cost_usd": 0.12,
    "total_duration_ms": 30000,
    "total_api_duration_ms": 5000,
    "total_lines_added": 10,
    "total_lines_removed": 2
  },
  "context_window": {
    "used_percentage": 45,
    "used_tokens": 45000,
    "max_tokens": 1000000
  },
  "rate_limits": {
    "five_hour": { "resets_at": 1779062766 }
  }
}
```

## Requirements (ADDED)

### CcInput TypeScript type MUST reflect the full CC payload

The `CcInput` interface in `apps/nexus-status/src/index.ts` MUST declare the full set of fields CC sends as of 2026-04-24, matching the canonical schema documented at [code.claude.com/docs/en/statusline](https://code.claude.com/docs/en/statusline). All fields MUST be marked optional to tolerate older CC versions and partial payloads. The minimum set:

```typescript
interface CcInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string };
  version?: string;
  output_style?: string;
  cost?: {
    total_cost_usd?: number;
    total_duration_ms?: number;
    total_api_duration_ms?: number;
    total_lines_added?: number;
    total_lines_removed?: number;
  };
  context_window?: {
    used_percentage?: number;
    used_tokens?: number;
    max_tokens?: number;
  };
  rate_limits?: {
    five_hour?: { resets_at?: number };
  };
}
```

### Context window percentage MUST come from CC payload, not be omitted

The renderer MUST read `context_window.used_percentage` (the field CC actually sends), convert to remaining-percentage for display purposes, and surface it in the statusline. The prior field name `remaining_percentage` MUST be removed from the type. When `used_percentage` is absent (older CC version / missing payload), the context bar MUST NOT render — matching current silent-omission behavior for that failure mode only.

The existing `CTX_HIGH / CTX_MED / CTX_LOW` color banding (>40% / 20-40% / <20% remaining) MUST continue to apply, computed from `100 - used_percentage`.

### Rate-limit segments MUST source from CC payload, not re-query agent

The 5H rate-limit segment (`5H ═────── 8% ↑122% ↻4:40h`) MUST derive its reset countdown from `rate_limits.five_hour.resets_at` (unix timestamp on stdin). The `↻` countdown MUST be `resets_at - now` formatted as HH:MM or Xd. The `%` bar and `↑%` trend indicator MAY continue using agent-analytics data where CC does not supply an equivalent, but MUST be clearly scoped to "agent-derived" so the user understands the 5H `↻` is from CC and the 5H `%` is from the agent's own counter. If CC later ships a used-percentage-so-far field for 5H, that MUST take precedence.

The 7D segment has no CC-side counterpart today and MAY continue as agent-sourced.

### Project resolution MUST prefer CC payload over git subprocess

When `workspace.project_dir` is present, the renderer MUST use `basename(workspace.project_dir)` as the project name, skipping the `git` subprocess entirely. The git branch + dirty-marker rendering MUST remain (it's not in the CC payload), but the project-name resolution MUST NOT invoke git. This removes up to 2 subprocess calls per render cycle.

### Cost segment MUST be added (non-intrusive)

When `cost.total_cost_usd` is present and ≥ $0.01, the statusline MUST render a compact cost indicator (e.g. `$0.12`) in the `DIM` color ANSI style. When below $0.01 or absent, MUST render nothing (no `$0.00` to reduce noise on fresh sessions). Placement: between the project name and the 5H segment.

### Line-delta segment MUST be added (non-intrusive)

When `cost.total_lines_added` AND `cost.total_lines_removed` are both present and non-zero, the statusline MUST render a compact delta (e.g. `+10/-2`) in the `DIM` color. When both are zero or absent, MUST render nothing.

### Output-style segment MUST be added (non-intrusive)

When `output_style` is present and is NOT the default `"default"`, the statusline MUST render the style name abbreviated to ≤ 8 chars (e.g. `tts-summ` for `tts-summary`, `explain` for `explanatory`) in the `DIM` color. The default style renders nothing to avoid clutter. Placement: between model name and git segment.

### Statusline MUST remain crash-safe

Any error parsing CC input MUST result in the existing empty-string fallback. New fields being absent MUST NEVER trigger an error path — only missing renders for those fields. The contract "statusline MUST NOT crash CC" is inviolable.

### Legacy `remaining_percentage` field MUST be removed from docstring

The file header comment `* Reads CC context from stdin (JSON piped by Claude Code):` MUST be updated to show the current canonical payload shape, with `used_percentage` as the context field name. Leaving the wrong field name in a documentation block is how we originally introduced the bug — documentation and code must match.

## Scope

**IN:**
- `apps/nexus-status/src/index.ts` — type update, context renderer fix, rate-limit reset sourcing, git-call elimination, three new segments (cost, line-delta, output-style)
- Header docstring update
- `apps/nexus-status/src/*.test.ts` — new unit tests covering the new payload fields and their absence
- Rebuild + deploy: `bun build src/index.ts --compile --outfile nexus-status` → `~/.local/bin/nexus-status`

**OUT:**
- Session name in statusline — CC feature request [#18022](https://github.com/anthropics/claude-code/issues/18022) is unshipped, so we cannot consume a field that doesn't exist
- TUI statusline (separate `apps/tui` area) — this proposal is scoped to `apps/nexus-status` only
- Dashboard display of any of these fields — separate concern
- Rate limit `used_percentage` via CC — CC does not ship this yet; we continue computing locally
- Visual redesign (new icons, new color palette) — scope creep; this is a data-correctness fix
- 5-hour / 7-day window algorithm changes — the analytics DB query is correct for what it claims to compute; only the `resets_at` source changes

## Impact

- **Behavioral:** Context bar starts rendering (regression fix). Cost / line-delta / output-style segments appear when relevant. Project-name resolution becomes deterministic (no git races).
- **Performance:** Removes up to 2 subprocess calls per render cycle. At 300 ms cadence, that's ~13,000 fewer fork/exec per hour of active session use. The HTTP call to agent-analytics stays (rate-limit bar computation still needs it).
- **Rendering size:** Each new segment adds ≤ 10 chars when present. Cumulative growth is bounded; ANSI color codes add ~10 bytes per segment. No risk of breaking terminal width assumptions.
- **Rollback:** Revert the diff; behavior returns to the silently-wrong context bar and the extra git subprocess calls. Zero data migrations, zero side effects.
- **Compatibility:** Payloads from older CC versions (where fields are absent) simply omit the matching segments — the statusline degrades gracefully.

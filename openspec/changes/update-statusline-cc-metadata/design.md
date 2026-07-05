# Design — update-statusline-cc-metadata

## Full field audit (2026-07-05 doc snapshot vs. current `CcInput`)

| Field | In current type? | Decision | Reasoning |
|---|---|---|---|
| `output_style` | yes, as `string` | **FIX** | CC now sends `{name: string}` — active rendering bug |
| `context_window.used_tokens`/`max_tokens` | yes | **REMOVE** | Never in any documented schema, unused in the renderer — dead type members |
| `context_window.context_window_size` | no | **ADOPT (type only)** | Real field; not rendered yet, but the type should mirror the payload CC actually sends |
| `exceeds_200k_tokens` | no | **ADOPT** | One boolean, one-line marker, higher-signal than % math alone for 1M-context models |
| `effort.level` | no | **ADOPT** | Directly matches how this setup runs sessions (`/effort`, ultracode) — glance-visible reasoning tier is useful |
| `thinking.enabled` | no | **SKIP** | Redundant with `effort.level` for glance purposes; adds a segment for marginal info |
| `rate_limits.seven_day.*` | no | **ADOPT** | Mirrors the precedent already set for `five_hour.resets_at` — prefer CC's own number over the agent-analytics derived one |
| `workspace.git_worktree` | no | **ADOPT** | This setup runs many parallel `/apply` worktrees (see cc `rules/CORE.md` `wt` CLI) — worth a glance badge |
| `workspace.added_dirs` | no | **SKIP** | `/add-dir` isn't part of this workflow today |
| `workspace.repo.*` | no | **SKIP** | Redundant with existing project-code derivation from `workspace.project_dir` |
| `pr.number`/`pr.url`/`pr.review_state` | no | **SKIP** | CC already renders this natively in the footer badge (per docs) — duplicating is clutter |
| `session_name` | no | **SKIP** | Only useful once sessions are routinely named; not current practice |
| `prompt_id` | no | **SKIP** | Internal OTel-correlation ID, not a glance signal |
| `vim.mode` | no | **SKIP** | Vim mode isn't in use in this setup |
| `agent.name` (top-level, `--agent` flag) | no | **SKIP** | Not a usage pattern here — distinct from the existing subagent-session list already shown |
| `subagentStatusLine` (separate config key) | n/a | **DEFER** | Genuinely separate capability/surface — own proposal if wanted |
| `COLUMNS`/`LINES` env passthrough for dynamic cap | n/a | **DEFER** | Real idea, cross-repo (the 40-char cap lives in cc's `roadmap-pulse`), cache-staleness edge cases not worth solving speculatively |
| `refreshInterval` settings key | n/a | **DEFER (config-only, separate PR)** | Pure config change, AGENTS.md skips proposals for those |

## Placement of new segments

Existing render order (`renderStatusline`, `apps/nexus-statusline/src/index.ts`):
session indicator → account domain → project code → cost → line-delta → model → output_style →
git branch → active spec → context bar → 5H/7D usage → pulse (own line).

New segments slot in as:
- `effort.level` — immediately after the model segment, before `output_style` (both are DIM
  model/session-configuration tags; keeping them adjacent groups related info).
- `workspace.git_worktree` — immediately after the git branch segment (same visual cluster).
- `exceeds_200k_tokens` — immediately before the context bar segment (it's a qualifier on that
  same number).
- `rate_limits.seven_day` — no new segment; it's a data-source swap inside the existing 7D
  render call, mirroring how 5H already prefers `ccInput.rate_limits.five_hour.resets_at`.

## Test fixture note

The canonical payload fixture in `index.test.ts` should be updated to the 2026-07-05 shape
(`output_style: {name: ...}`, `rate_limits.seven_day`, `exceeds_200k_tokens`, `effort`,
`workspace.git_worktree`) so every existing assertion continues to exercise the real shape CC
sends, not the stale 2026-04-24 one.

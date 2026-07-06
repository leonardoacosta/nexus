# Update Statusline CC Metadata — sync payload type, fix output_style regression, adopt high-signal new fields

## Context
- touches: `apps/nexus-statusline/src/index.ts`, `apps/nexus-statusline/src/index.test.ts`
- prior art: `openspec/changes/archive/2026-04-27-fix-nexus-status-cc-payload/` (last full payload sync, 2026-04-24 schema snapshot)

## Why

Two things converged this session:

1. **cc's `roadmap-pulse --line` now emits a two-line "pulse" segment** (`next: <title>` on
   its own line, `radar:stale`/openspec counts on the next) instead of squeezing both onto one
   40-char line and sometimes dropping the counts. `nexus-statusline` already passes the cached
   `pulse` string through verbatim (`readFileSync(...).trim()` preserves embedded `\n`), so this
   needed zero code change — but the behavior is now load-bearing and untested. A future refactor
   of the pulse-render path could silently collapse it back to one line with no test to catch it.

2. **The CC statusline payload has drifted since the 2026-04-24 snapshot** the `CcInput` type was
   last synced against (per [code.claude.com/docs/en/statusline](https://code.claude.com/docs/en/statusline),
   re-fetched 2026-07-05). One drift is an active bug: `output_style` is now sent as an object
   (`{"name": "default"}`), not a bare string — `ccInput.output_style !== "default"` and
   `shortenOutputStyle(outputStyle)` both silently misbehave against an object. Several new fields
   also showed up (`exceeds_200k_tokens`, `effort.level`, `rate_limits.seven_day`,
   `workspace.git_worktree`, `pr.*`, `vim.mode`, `agent.name`, `session_name`, `prompt_id`,
   `workspace.added_dirs`, `workspace.repo.*`) that didn't exist at the last sync.

Full field-by-field adopt/skip rationale is in `design.md` — short version: adopt what's a
one-line, high-signal glance addition or fixes an active bug; skip what CC already surfaces
natively elsewhere (PR badge) or has no evidenced use in this setup (vim mode, `--agent`
sessions, named sessions).

## What Changes

1. **Fix `output_style` regression** — parse `ccInput.output_style?.name`, not `ccInput.output_style`
   as a bare string. Active bug: the style segment has been silently broken since CC shipped the
   object form.

2. **Sync `CcInput` type to the current canonical payload** — drop the never-real `used_tokens`/
   `max_tokens` fields (not in any documented schema, unused in the renderer), add
   `context_window_size`, `exceeds_200k_tokens`, `effort.level`, `rate_limits.seven_day`,
   `workspace.git_worktree`.

3. **Add three new segments**:
   - `exceeds_200k_tokens` marker next to the context bar.
   - `effort.level` DIM tag near the model segment.
   - `workspace.git_worktree` badge near the git segment (this setup runs many parallel
     `/apply` worktrees — see `wt` CLI in cc's `rules/CORE.md` — a glance-visible worktree name
     disambiguates which pane is which).

4. **Prefer CC-sourced `rate_limits.seven_day`** over the agent-analytics-derived 7D value,
   same precedence the 2026-04-27 proposal already established for 5H (its own text flagged this
   as a follow-up: "The 7D segment has no CC-side counterpart today" — it does now).

5. **Lock in the multi-line pulse pass-through** with a regression test asserting an embedded
   `\n` in `deps.pulse` renders as two separate rows, not one.

## Out of Scope

- `pr.*` segment — CC's docs state this "mirrors the PR badge in the bottom status bar"; CC
  already renders it natively. Duplicating it in our custom line is clutter, not signal.
- `session_name`, `prompt_id`, `vim.mode`, `agent.name`, `workspace.added_dirs`,
  `workspace.repo.*` — no evidenced glance-value in this setup today (no named sessions, no vim
  mode, no `--agent` flag usage). Add if/when a concrete need shows up.
- `subagentStatusLine` (the new per-subagent-row config surface) — a genuinely separate capability
  (own schema, own script, own settings key), not a fit for a "sync the payload type" change. File
  as its own proposal if wanted.
- Dynamic terminal-width sizing via the new `COLUMNS`/`LINES` env vars (v2.1.153+) instead of
  `roadmap-pulse`'s hardcoded 40-char cap — real idea, but it's a cc-side change (the cap lives in
  `roadmap-pulse`, not here) plus cache-staleness edge cases (pulse is refreshed every 5 min in the
  background, terminal width can change every render). Not worth the complexity until the
  hardcoded cap causes an actual complaint.
- `refreshInterval` / `hideVimModeIndicator` settings.json keys — pure configuration, no code
  change; AGENTS.md explicitly skips proposals for configuration-only changes. Worth doing
  (`refreshInterval` would keep the 5H/7D countdown ticking while idle on background subagents)
  but as a direct cc-side settings.json edit, not part of this change.

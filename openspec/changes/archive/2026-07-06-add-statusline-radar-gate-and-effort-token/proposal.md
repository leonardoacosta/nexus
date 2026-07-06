# Add Statusline Radar Gate (B&B-only) + Row-One Model/Effort Token + Context Usage

## Context

- touches: `apps/nexus-statusline/src/index.ts`, `apps/nexus-statusline/src/index.test.ts`
- relationship to pending change `update-statusline-cc-metadata` (open, 0/16 tasks): this change
  **depends on** its `CcInput` type adoption of `effort.level` and `context_window.context_window_size`
  (its tasks 1.2/1.4), and **supersedes** its `Reasoning-effort tag` ADDED requirement (a standalone
  DIM `xhigh` tag) with the combined model+effort token below. Sequence this change after it, and
  drop the standalone tag render in the same edit that lands the token. Coordinated: both changes
  are Leo's, same session-week.
- prior art: `openspec/changes/archive/2026-04-27-fix-nexus-status-cc-payload/` (payload sync),
  cc `scripts/bin/roadmap-pulse` (pulse producer), cc `commands/apply/references/project-toml-schema.md`
  (project.toml schema).

## Why

cc archived `/next` and `/open` today (2026-07-05) — both superseded by the passive
`roadmap-pulse` statusline surface (Ambient Surfacing pattern; the script header records the
motivation: `/next` 66 uses then dead 5 weeks, `/open` 72 uses then dead 8 weeks). The statusline
is now the primary "what should I look at" surface, so its per-glance signal quality matters.
Two problems, both runtime-verified 2026-07-05:

1. **The radar segment renders for ALL projects.** `roadmap-pulse` reads the global request-radar
   ledger (`~/.claude/state/request-radar/ledger.json` — Outlook/Teams/ServiceNow/ADO inbound
   asks) regardless of which project it runs in, and `getRoadmapPulse` in
   `apps/nexus-statusline/src/index.ts` passes the cached line through verbatim. Live evidence:
   `~/.claude/scripts/state/roadmap-pulse.nx.line` currently reads
   `next: reply Fireball/fireball (...` + `7o,radar:stale` — a B&B work nag rendered inside nx, a
   personal repo. Radar data only makes sense for B&B work (fleet codes ws fb dc se tb sc ba bo
   es ew ic lu pp); on personal projects it is noise that trains the eye to skip the pulse rows.

2. **Row one under-reports the session.** The model segment renders only the version number
   (`shortenModel("Fable 5")` returns `"5"` — `parts[1]` of the display name), the reasoning
   effort is invisible, and the context bar shows only a remaining-percentage (`renderContext`),
   with no absolute token usage even though the payload carries `context_window_size`.

## What Changes

1. **Gate radar-derived pulse content to B&B projects.** New `isBbProject(projectDir)` helper:
   read `<projectDir>/.claude/project.toml` and treat `org = "bb"` under `[project]` as
   authoritative; when the file or key is absent, fall back to a hardcoded allowlist of B&B
   project codes (`ws fb dc se tb sc ba bo es ew ic lu pp`) matched against the existing
   project-code resolution (`basename(workspace.project_dir)` / `deriveProjectCode`). Non-B&B:
   the `radar:stale` counts token is stripped at render, and the background refresh spawn passes
   `PULSE_RADAR=0` so the producer can skip radar rungs entirely (cc-side follow-up, see Impact).
   Full decision analysis in `design.md` Decision 1 + 2.

2. **Row-one model/effort token.** Replace the model segment with a compact token: model letter
   (`F`=Fable, `O`=Opus, `S`=Sonnet, `H`=Haiku, derived from `model.id` with `display_name`
   fallback) + effort suffix from `effort.level` (`l`=low, `m`=medium, `h`=high, `xh`=xhigh,
   `u`=max/ultracode). Examples: `Fu`, `Fh`, `Ou`, `Om`, `Sxh`. Effort absent → letter alone.
   Supersedes the pending standalone effort tag (see Context).

3. **Row-one context usage.** Extend the existing CTX gauge suffix with approximate absolute
   usage (`84k/200k`) derived from `used_percentage x context_window_size` when
   `context_window_size` is present. The payload has no direct used-token field (the old
   `used_tokens`/`max_tokens` were never in any documented schema — see `design.md` Open
   Questions).

## Out of Scope

- **cc-side changes** — `roadmap-pulse` honoring `PULSE_RADAR=0` (skip rung-1 radar next + radar
  counts, letting rungs 2-7 backfill `next:`) and the `org` key addition to
  `project-toml-schema.md` are cc-repo work. Without them this change still hides the
  `radar:stale` token everywhere non-B&B, but a radar-sourced `next: reply ...` row can still
  leak until cc's script honors the flag (lexical filtering of that row was evaluated and
  rejected — `design.md` Decision 2). Tracked as a filed follow-up (tasks 4.x), not silently
  assumed.
- Authoring `.claude/project.toml` manifests in the 13 B&B repos (none has one today, verified
  2026-07-05) — the allowlist fallback carries the gate until those land.
- Re-implementing roadmap-pulse's 7-rung "next" precedence in nx (rejected, `design.md`
  Decision 2).
- Any other row-one segment changes — cost, line-delta, git, 5H/7D stay as-is;
  `update-statusline-cc-metadata` already covers `exceeds_200k_tokens`, worktree badge, 7D
  source precedence.

## Impact

- Affected specs: `statusline-renderer` (1 MODIFIED, 2 ADDED requirements).
- Affected code: `apps/nexus-statusline/src/index.ts`, `apps/nexus-statusline/src/index.test.ts`,
  redeploy of the compiled `~/.local/bin/nexus-statusline` binary.
- Cross-repo (informational, not executed by this change): cc `scripts/bin/roadmap-pulse`
  (`PULSE_RADAR` support), cc `commands/apply/references/project-toml-schema.md` (`[project].org`
  key), B&B repo manifests.

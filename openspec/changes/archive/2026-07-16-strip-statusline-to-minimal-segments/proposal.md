---
order: 0716a
---

# Proposal: strip-statusline-to-minimal-segments

## Why

Leo's ask (`/openspec:explore` + a fan-out of `/feature` proposals, run from the `installfest`
repo this session): model, git, and usage-gauge information is moving INTO cc-tmux's row 2
(session bar) — see the sibling proposals `cc-tmux-row2-model-color-usage-format` and
`cc-tmux-braille-flash-and-permission-pulse` in `installfest`. With that info now living in the
tmux status bar, nexus-statusline (Claude Code's own statusLine, rendered inline in each pane)
no longer needs to duplicate it. Leo's explicit removal list: session dot, cost, lines, model,
output style, git status, the 200k marker, CTX, 5H, 7D, tokens/sec speed, and the trailing
drift/pulse/spec lines. KEPT: account domain, project code, session clock, worktree badge, and
the trailing roadmap line.

**Sequencing note**: land this AFTER the cc-tmux row-2 proposal (`cc-tmux-row2-model-color-
usage-format`) ships, so cc-tmux carries the replacement info before nexus-statusline stops
showing it — avoids a window where neither surface shows model/git/usage. This proposal has no
mechanical dependency on that one (different repos, no shared file), but the ROLLOUT order
matters; note it here since `/triage`/`wave-plan-build` can't see across repos.

**Classification, not guesswork** (`Explore` agent read all 30 requirements in
`openspec/specs/statusline-renderer/spec.md` plus the actual source, not just requirement
titles, before this list was finalized):
- 11 of 30 requirements are REMOVED outright (each governs a segment being removed).
- 19 are KEPT — most are segment-independent infrastructure (crash-safety, spawn-injection
  guards, cache GC, module organization) that must survive regardless of which segments render;
  two are KEPT but RE-SCOPED (the canonical-payload type trims removed fields; the usage-cache
  wire-contract requirement keeps its writer + cc-tmux's independent reader, only
  nexus-statusline's own reader goes).
- **Resolved, not assumed**: "roadmap" (kept) and "pulse" (removed) are genuinely DIFFERENT
  trailing lines with different producers/caches (`getRoadmapLine` fetches `GET /roadmap`,
  caches `bead-roadmap.*.json`; `getRoadmapPulse` shells to a local `roadmap-pulse` binary,
  caches `roadmap-pulse.*.line`) — confirmed by reading `agent-lines.ts`, not inferred from
  naming similarity.
- **Resolved, not assumed**: `usage-cache.json` is cross-process — `packages/statusline-
  contract`'s own docs state it's read by nexus-statusline AND, externally, cc-tmux's
  `usage.py`, written by the agent. Removing the statusline's OWN 5H/7D render does not remove
  the file, its writer, or cc-tmux's independent read of it.
- **Resolved, not assumed**: `context-guard.ts`'s spurious-zero guard survives even with CTX
  gone — its resolved value feeds a separate, unrelated requirement ("nexus-statusline SHALL
  push its resolved context-window reading to nx-agent on every render"), not just the CTX
  render.
- **This proposal's own interpretation call**: the removal list's bare "spec" (singular, vs. the
  code's plural "specs" trailing line AND a SEPARATE inline "⚡ spec" marker sourced from a
  different endpoint) is read as covering BOTH — neither is on the explicit keep-list
  (`@domain`, project code, session clock, worktree badge, roadmap line), so both go. Flagged
  here in case that reading is wrong.

## What Changes

- **`apps/nexus-statusline/src/render.ts`**: remove the session-dot, `$cost`, `+N/-M` lines,
  `M:<model+effort>`, output-style tag, git-branch/dirty/ahead, worktree-badge's git-status
  dependency (worktree badge itself stays — re-derive its trigger from `workspace.git_worktree`
  directly, not from the now-removed branch fetch, if it was coupled), `⚡ spec` inline marker,
  `200K+` marker, `CTX` gauge, `≈Nt/s` speed, `5H`/`7D` gauges, and the pulse/specs/drift
  trailing rows from `renderStatusline`'s composition. Keep: session dot's REPLACEMENT is
  nothing (removed outright, not replaced) — `@domain`, project code, session clock, and the
  roadmap trailing row remain.
- **`apps/nexus-statusline/src/agent-lines.ts`**: remove `getRoadmapPulse`, `getSpecsLine`,
  `getDriftLine`, `formatDriftLine`. Keep `getRoadmapLine`. Remove `fetchStatusline` (session
  list, backing the removed session dot and `⚡ spec` marker) UNLESS anything else still calls
  it — verify via grep before deleting (task-level check, not assumed here).
- **`apps/nexus-statusline/src/usage.ts`**: remove `resolveUsage`/`buildStdinUsage`/
  `polledUsageFromCache` (fed the now-removed 5H/7D gauges) and `FETCH_TIMEOUT_MS` if nothing
  else references it. Keep `getAccountDomain` (feeds the kept `@domain` segment).
- **`apps/nexus-statusline/src/speed.ts`**: remove entirely (only fed the removed `≈Nt/s`
  segment) — verify no other caller first.
- **`apps/nexus-statusline/src/context-guard.ts`**: KEEP the file/function (`resolveContext`)
  since its resolved value still feeds the separate nx-agent context-push requirement, but
  remove the CALL SITE in `render.ts` that turned its output into the CTX gauge text — the guard
  itself keeps running, its render-facing consumer goes.
- **`apps/nexus-statusline/src/types.ts`**: trim `CcInput`/`RenderDeps` fields that only existed
  to feed removed segments (cost, lines, output_style, git status shape, context_window,
  exceeds_200k_tokens) — keep fields still read for kept segments or by other repo consumers
  (re-export types cc-tmux/nx-agent still need stay, even if this package stops using them
  itself).
- **`apps/nexus-statusline/src/index.ts`**: remove the parallel fetch calls that only fed
  removed segments (the live `git` subprocess call, if nothing else needs it; the
  `fetchStatusline`/speed/usage calls per the above, gated on the grep-before-delete check).
- **`openspec/specs/statusline-renderer/spec.md`**: REMOVE the 11 requirements the Explore
  classification identified (Context bar, Rate-limit countdown, Cost segment, Line-delta
  segment, Output-style segment, 200k marker, Multi-line pulse pass-through, Radar-derived pulse
  content, Row-one model-effort token, "prefer CC stdin usage" usage-resolution, tokens-per-
  second, gauge-width-adapts). MODIFY the two re-scoped requirements (canonical-payload type,
  usage-cache wire contract) to reflect the trimmed field set / statusline-side reader removal.
  All 17 remaining requirements are restated UNCHANGED.

## Non-Goals

- No change to nx-agent's own usage-cache WRITER, the `/roadmap` endpoint, or any other backend
  behavior — this proposal only removes nexus-statusline's client-side rendering of removed
  segments and the now-dead code paths feeding them.
- No change to cc-tmux's own reading of `usage-cache.json` or any cc-tmux code at all — that's
  the sibling `installfest` proposals' scope, not this one's.
- No change to the account-domain resolution, project-code resolution, session-clock formatting,
  or worktree-badge trigger logic themselves — only their surrounding (now-removed) neighbors.

## Context
- touches: `apps/nexus-statusline/src/render.ts`, `apps/nexus-statusline/src/agent-lines.ts`,
  `apps/nexus-statusline/src/usage.ts`, `apps/nexus-statusline/src/speed.ts`,
  `apps/nexus-statusline/src/context-guard.ts`, `apps/nexus-statusline/src/types.ts`,
  `apps/nexus-statusline/src/index.ts`

## Testing

- `apps/nexus-statusline`'s existing test suite (`bun test`, per the "test script MUST run its
  real suite" requirement, kept unchanged) — extend/trim its fixtures so no removed-segment
  assertion remains, and add assertions that a real rendered line contains none of the removed
  segments' distinguishing substrings (`$`, `CTX`, `5H:`, `7D:`, `M:`) while still containing the
  kept ones (`@`, the project code, the session-clock glyph `⧗`).
- Live verification: render a real statusline payload through the trimmed `renderStatusline` and
  paste the actual output, confirming visually it matches the kept-segment list.

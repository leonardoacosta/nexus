# Tasks — add-statusline-radar-gate-and-effort-token

> Sequencing: land AFTER `update-statusline-cc-metadata` (this change consumes its `CcInput`
> adoption of `effort.level` + `context_window.context_window_size`, and replaces its standalone
> effort-tag render with the combined token).

## 1. API Batch (TypeScript, nexus-statusline source)

- [ ] [1.1] [P-1] `apps/nexus-statusline/src/index.ts` — add `isBbProject(projectDir)`: regex-parse `<projectDir>/.claude/project.toml` for an `org` key under `[project]` (authoritative when present, `"bb"` = B&B; same no-TOML-dep regex approach as `getLocalAgentUrl`); fall back to the allowlist `ws fb dc se tb sc ba bo es ew ic lu pp` matched against the project code (`basename(workspace.project_dir)` / `deriveProjectCode`). All reads wrapped; never throws. [owner:api-engineer]
- [ ] [1.2] [P-1] Same file — thread the gate through `getRoadmapPulse` / `renderStatusline`: (a) when non-B&B, strip the exact `radar:stale` token from the pulse counts row (drop the row if it becomes empty); (b) pass `PULSE_RADAR=0|1` in the env of the existing detached refresh spawn. [owner:api-engineer]
- [ ] [1.3] [P-1] Same file — replace the `shortenModel` model segment with the model-effort token: family letter from `model.id` (fallback `display_name`; unknown family → `display_name` initial) + effort suffix map `low/medium/high/xhigh/max|ultracode` → `l/m/h/xh/u`; effort absent/unrecognized → letter alone; model absent → no token. Remove the now-dead `shortenModel` and (if `update-statusline-cc-metadata` landed first) its standalone effort-tag render. [owner:api-engineer]
- [ ] [1.4] [P-2] Same file — extend `renderContext` suffix with `<used>k/<size>k` derived from `used_percentage x context_window_size` when `context_window_size` is a positive number; percentage-only render unchanged otherwise. [owner:api-engineer]

## 2. E2E Batch (unit tests)

- [ ] [2.1] [P-1] `apps/nexus-statusline/src/index.test.ts` — gate tests: nx (non-B&B) strips `radar:stale` from `"next: x\n7o,radar:stale"` leaving `7o`; ws (allowlist, no toml) keeps it; `org = "bb"` toml overrides a non-allowlisted code; unreadable toml falls back without throwing. [owner:e2e-engineer]
- [ ] [2.2] [P-1] Test: refresh spawn env carries `PULSE_RADAR=0` for non-B&B and `PULSE_RADAR=1` for B&B (mock/spy on the spawn). [owner:e2e-engineer]
- [ ] [2.3] [P-1] Token tests: `Fu` (fable+max), `Sxh` (sonnet+xhigh), `O` (opus, no effort), no token when model absent, `Nl` fallback for unknown family, no standalone version-number segment remains. [owner:e2e-engineer]
- [ ] [2.4] [P-2] Runtime evidence: capture a real statusline stdin payload from an ultracode/max session and paste the observed `effort.level` wire value into this change's design.md Open Question 2 (expected `max`; `ultracode` also maps to `u`). [owner:e2e-engineer]
- [ ] [2.5] [P-2] CTX tests: `{used_percentage: 42, context_window_size: 200000}` renders `84k/200k`; missing `context_window_size` renders percentage-only. [owner:e2e-engineer]
- [ ] [2.6] [P-1] Regression: empty payload `{}` renders without throwing and with none of the new behavior visible (crash-safe contract). [owner:e2e-engineer]

## 3. Build + Deploy Batch

- [ ] [3.1] [P-1] `cd ~/dev/nx/apps/nexus-statusline && bun build src/index.ts --compile --outfile nexus-statusline`; copy to `~/.local/bin/nexus-statusline`. No systemd restart (invoked per-render). [owner:devops-engineer]
- [ ] [3.2] [P-3] Visual validation: open a CC session in nx (no radar token, model-effort token present, CTX shows `k/k` usage) and one in ws (radar token still renders). [owner:ux-specialist]

## 4. Cross-repo coordination (filed, not implemented here)

- [ ] [4.1] [P-2] File the cc-side follow-up (bd issue in cc) for `roadmap-pulse` to honor `PULSE_RADAR=0` — skip rung-1 radar next + radar counts so rungs 2-7 backfill `next:` — and for adding `[project].org` to `commands/apply/references/project-toml-schema.md`. [owner:api-engineer]

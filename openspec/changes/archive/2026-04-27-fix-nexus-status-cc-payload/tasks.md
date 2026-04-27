# Implementation Tasks

## API Batch (TypeScript, nexus-status source)

- [x] [1.1] [P-1] `apps/nexus-status/src/index.ts` — expand the `CcInput` interface to the full canonical payload per the proposal. All fields optional. Keep the interface at the top of the file where the current 2-field version lives. [owner:api-engineer]
- [x] [1.2] [P-1] Same file — rewrite the context-window render path. Read `context_window.used_percentage`; compute `const remaining = used != null ? 100 - used : null`. Feed `remaining` to `renderContext()` unchanged. Remove the `remaining_percentage` reference. [owner:api-engineer]
- [x] [1.3] [P-1] Same file — update the header docstring (`* Reads CC context from stdin (JSON piped by Claude Code):`) to reflect the actual CC payload. Include at minimum `context_window.used_percentage`, `model.display_name`, `cost.total_cost_usd`, `rate_limits.five_hour.resets_at`. Strike the old `remaining_percentage` wording. [owner:api-engineer]
- [x] [1.4] [P-1] Same file — add the cost segment. When `ccInput.cost?.total_cost_usd >= 0.01`, render `${DIM}$${total_cost_usd.toFixed(2)}${RESET}`. Placement: after project name, before 5H segment. [owner:api-engineer]
- [x] [1.5] [P-1] Same file — add the line-delta segment. When `ccInput.cost?.total_lines_added != null && ccInput.cost?.total_lines_removed != null && (added > 0 || removed > 0)`, render `${DIM}+${added}/-${removed}${RESET}`. Placement: after cost segment. [owner:api-engineer]
- [x] [1.6] [P-2] Same file — add the output-style segment. When `ccInput.output_style && ccInput.output_style !== "default"`, render an 8-char truncation of the style name in `DIM`. Placement: after model name. [owner:api-engineer]
- [x] [1.7] [P-1] Same file — rate-limit reset sourcing. When `ccInput.rate_limits?.five_hour?.resets_at` is present, use it as the `↻` countdown for the 5H segment instead of whatever the agent-analytics query currently returns. Fall back to agent-sourced reset only when the CC field is absent. [owner:api-engineer]
- [x] [1.8] [P-1] Same file — project-name resolution. When `ccInput.workspace?.project_dir` is present, use `basename(project_dir)` as the project name and skip the `git remote get-url origin` subprocess. Only retain the git call for branch + dirty detection (until CC ships those fields separately). [owner:api-engineer]

## E2E Batch (unit tests)

- [x] [2.1] [P-1] Add `apps/nexus-status/src/index.test.ts` (or extend existing test file if present) with a fixture representing the current canonical CC payload. Assert the rendered output contains a context-bar segment. [owner:e2e-engineer]
- [x] [2.2] [P-1] Test: CC payload with `used_percentage: 25` renders `~75%` remaining color-banded as `CTX_HIGH`. [owner:e2e-engineer]
- [x] [2.3] [P-1] Test: CC payload with `used_percentage: 85` renders `~15%` remaining color-banded as `CTX_LOW`. [owner:e2e-engineer]
- [x] [2.4] [P-1] Test: payload missing `context_window` at all — the renderer MUST NOT crash and MUST NOT render a context segment. [owner:e2e-engineer]
- [x] [2.5] [P-1] Test: `cost.total_cost_usd = 0.12` renders `$0.12` in DIM. [owner:e2e-engineer]
- [x] [2.6] [P-1] Test: `cost.total_cost_usd = 0.003` (below threshold) renders no cost segment. [owner:e2e-engineer]
- [x] [2.7] [P-1] Test: `cost.total_lines_added = 10`, `total_lines_removed = 2` renders `+10/-2`. Zero values render nothing. [owner:e2e-engineer]
- [x] [2.8] [P-2] Test: `output_style = "tts-summary"` renders an 8-char truncation. `output_style = "default"` renders nothing. [owner:e2e-engineer]
- [x] [2.9] [P-1] Test: `rate_limits.five_hour.resets_at` in 30 minutes renders `↻30m` (or equivalent format). [owner:e2e-engineer]
- [x] [2.10] [P-1] Test: `workspace.project_dir = "/home/x/dev/oo"` — assert the renderer uses `oo` as project and does NOT invoke `git remote get-url`. Mock `execSync` to detect the call. [owner:e2e-engineer]

## Build + Deploy Batch

- [x] [3.1] [P-1] `cd ~/dev/nx/apps/nexus-status && bun build src/index.ts --compile --outfile nexus-status`. Copy to `~/.local/bin/nexus-status`. No systemd restart required (statusline is invoked per-render). [owner:devops-engineer]
- [ ] [3.2] [P-2] Visual validation: open a CC session and confirm the statusline renders the context bar, any relevant cost/line-delta segments, and the rate-limit countdown. Capture a before/after screenshot for the PR description. [owner:ux-specialist]

## Regression Batch

- [x] [4.1] [P-1] Verify behavior in the empty-payload degraded-mode: pipe `{}` to the binary. Current behavior is empty string or minimal rendering. New behavior MUST match (no regression in the degraded path). [owner:e2e-engineer]

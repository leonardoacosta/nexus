# Tasks — update-statusline-cc-metadata

## API Batch (TypeScript, nexus-statusline source)

- [x] [1.1] [P-1] `apps/nexus-statusline/src/index.ts` — fix `output_style`: change the `CcInput` field to `output_style?: { name?: string }` and update the render path to read `ccInput.output_style?.name`. This is an active regression (CC sends an object, code treats it as a string). [owner:api-engineer]
- [x] [1.2] [P-1] Same file — remove `context_window.used_tokens`/`max_tokens` from `CcInput` (never in any documented schema, unused in the renderer). Add `context_window.context_window_size?: number`. [owner:api-engineer]
- [x] [1.3] [P-2] Same file — add `exceeds_200k_tokens?: boolean` to `CcInput`; when `true`, render a compact marker immediately before the context bar segment. [owner:api-engineer]
- [x] [1.4] [P-2] Same file — add `effort?: { level?: string }` to `CcInput`; when `level` is present, render it as a DIM tag immediately after the model segment, before `output_style`. [owner:api-engineer]
- [x] [1.5] [P-2] Same file — add `rate_limits.seven_day?: { used_percentage?: number; resets_at?: number }` to `CcInput`. When present, prefer it as the 7D segment's source (same precedence pattern already used for `five_hour.resets_at`); fall back to the existing agent-analytics-derived value when absent. [owner:api-engineer]
- [x] [1.6] [P-2] Same file — add `workspace.git_worktree?: string` to `CcInput`; when present, render a badge immediately after the git branch segment. [owner:api-engineer]
- [x] [1.7] [P-3] Same file — update the header docstring's schema comment to the 2026-07-05 canonical payload shape (drop `used_tokens`/`max_tokens`, add the newly-adopted fields). [owner:api-engineer]

## E2E Batch (unit tests)

- [x] [2.1] [P-1] `apps/nexus-statusline/src/index.test.ts` — update the canonical payload fixture to `output_style: {name: "..."}` object form; assert the style segment renders correctly and that a payload with the old bare-string form does not crash (degrades gracefully). [owner:e2e-engineer]
- [x] [2.2] [P-2] Test: `exceeds_200k_tokens: true` renders the marker; `false`/absent renders nothing. [owner:e2e-engineer]
- [x] [2.3] [P-2] Test: `effort: {level: "xhigh"}` renders the tag; absent `effort` renders nothing. [owner:e2e-engineer]
- [x] [2.4] [P-2] Test: `rate_limits.seven_day.resets_at` present is preferred over agent-analytics-derived data for the 7D countdown; absent falls back to current behavior. [owner:e2e-engineer]
- [x] [2.5] [P-2] Test: `workspace.git_worktree: "my-feature"` renders the badge after the git segment; absent renders nothing. [owner:e2e-engineer]
- [x] [2.6] [P-1] Test: `deps.pulse` containing an embedded `\n` (e.g. `"next: Merge Slot\nradar:stale"`) renders as two separate trailing rows, not squeezed onto one line — locks in the multi-line pass-through this proposal was prompted by. [owner:e2e-engineer]
- [x] [2.7] [P-1] Regression: empty payload `{}` still renders without throwing and without any of the new segments appearing (degraded-mode parity, matching existing `[4.1]`/`[4.1b]` tests). [owner:e2e-engineer]

## Build + Deploy Batch

- [x] [3.1] [P-1] `cd ~/dev/nx/apps/nexus-statusline && bun build src/index.ts --compile --outfile nexus-statusline`. Copy to `~/.local/bin/nexus-statusline`. No systemd restart required (statusline is invoked per-render). [owner:devops-engineer]
- [x] [3.2] [P-3] Visual validation: open a CC session, confirm the new segments (effort, exceeds_200k marker, worktree badge, 7D-from-CC) render correctly and the output_style fix no longer misbehaves. [owner:ux-specialist] — validated via compiled-binary render with a synthetic canonical payload (`echo '{...}' | ~/.local/bin/nexus-statusline`): segments render in designed order `model -> effort(xhigh) -> output_style(tts) -> git(main*) -> worktree -> 200K+ -> CTX -> 5H -> 7D`, and the multi-line pulse passes through as two rows. Full live in-CC confirmation still benefits from an interactive session, but the render path is proven end-to-end on the shipped binary.

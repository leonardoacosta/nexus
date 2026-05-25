<!-- beads:epic:nx-jnqzb -->
<!-- beads:feature:nx-rs738 -->

# Tasks: pty-tmux-integration-tests

## API Batch

Tier 1 — injectable spawn seam + argv unit tests. Always-on (no tmux required).

- [x] [1.1] Add a `SpawnFns` adapter interface to `apps/agent/src/terminal/tmux-pty-source.ts` (`{ spawn: typeof Bun.spawn; spawnSync: typeof Bun.spawnSync }`) and accept it via a new `TmuxPtySourceOptions.spawn` field, defaulting to `{ spawn: Bun.spawn, spawnSync: Bun.spawnSync }`. Replace all 12 direct `Bun.spawn*` call sites with the injected adapter. Production behavior MUST be byte-for-byte unchanged. [owner:api-engineer] [type:refactor] [beads:nx-walq5]
- [x] [1.2] [P-1] Author `apps/agent/src/terminal/tmux-pty-source.test.ts`: inject a recording mock adapter (captures argv, returns canned `{exitCode, stdout, stderr}`) and assert exact argv for scrollback seed (`capture-pane -p -S -<n> -E - -t`) and geometry sample (`display-message -p -t <target> #{pane_width}x#{pane_height}` + `<cols>x<rows>` parse). [owner:api-engineer] [type:test] [beads:nx-bkv7r]
- [x] [1.3] [P-1] Extend `tmux-pty-source.test.ts`: assert `write()` produces `send-keys -t <target> -l <text>` (the `-l` literal flag present — the regression that caused auto-Enter), and that empty/closed writes are no-ops. [owner:api-engineer] [type:test] [beads:nx-1ezwm]
- [x] [1.4] [P-1] Extend `tmux-pty-source.test.ts`: assert the resize path — first `resize()` reads prior `window-size`, sets `manual`, then `resize-window -x -y`; second `resize()` does NOT re-capture; `restoreWindowSize()` reverts to the recorded value and a never-resized restore is a no-op. [owner:api-engineer] [type:test] [beads:nx-kgh28]
- [x] [1.5] [P-1] Extend `tmux-pty-source.test.ts`: assert `close()` invokes `pipe-pane -t <target>` (no command), kills the reader child, and removes the temp FIFO dir (assert the dir no longer exists). [owner:api-engineer] [type:test] [beads:nx-pokvi]
- [x] [1.6] Run `bun test apps/agent/src/terminal/tmux-pty-source.test.ts` and confirm all Tier 1 assertions pass with the recording mock (no real tmux spawned). Paste the passing stdout. [owner:api-engineer] [type:test] [beads:nx-max7k]

## E2E Batch

Tier 2 — real-tmux round-trip against a deterministic TUI surrogate. `hasTmux`-gated.

- [x] [2.1] Author the deterministic TUI surrogate fixture at `apps/agent/test/fixtures/tui-surrogate.sh`: a bash/ANSI script using `tput`/`printf` that prints a known marker line, echoes typed input at a fixed position, and appends a submission marker only on carriage return. Fully deterministic output (no timers, no randomness). [owner:e2e-engineer] [type:test] [beads:nx-4yzbd]
- [x] [2.2] Author `apps/agent/src/terminal/tmux-pty-source.integration.test.ts` with a `hasTmux` probe (`command -v tmux`) and `describe.skipIf(!hasTmux)`. Set up/teardown a dedicated tmux session running the surrogate via `tmux new-session -d` at a known geometry; kill the session in `afterEach`/`afterAll`. [owner:e2e-engineer] [type:test] [beads:nx-903k6]
- [x] [2.3] [P-1] Integration assertions — read path: attach a `TmuxPtySource`, assert `geometry()` returns the pane's real `<cols>x<rows>` (not the 80x24 default), and that seeded scrollback contains the surrogate's marker line byte-exact. [owner:e2e-engineer] [type:test] [beads:nx-8hy1k]
- [x] [2.4] [P-1] Integration assertions — write path: write raw bytes without `0x0D` and assert the surrogate shows the chars but registers NO submission; then write `0x0D` and assert exactly one submission (the auto-Enter regression guard, end-to-end). [owner:e2e-engineer] [type:test] [beads:nx-nt5ct]
- [x] [2.5] [P-1] Integration assertions — resize + teardown: call `resize(cols, rows)` to a new size, assert a later `geometry()` reflects it and the surrogate reflowed; then kill the pane and assert the output stream completes, the temp FIFO dir is removed, and forced `window-size manual` is reverted. [owner:e2e-engineer] [type:test] [beads:nx-765mt]
- [x] [2.6] Run `bun test apps/agent/src/terminal/tmux-pty-source.integration.test.ts` on a tmux-equipped host and confirm the round-trip passes (not skipped). Paste the passing stdout. [owner:e2e-engineer] [type:test] [beads:nx-lp4bd]

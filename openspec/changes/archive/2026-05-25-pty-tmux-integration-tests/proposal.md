# pty-tmux-integration-tests

## Why

Every PTY-attach bug fixed this session was a **real-tmux-interaction** bug that the
existing test suite structurally could not catch:

| Bug | Root cause (real tmux behavior) | Caught by tests? |
| --- | --- | --- |
| "Session not found but in list" | stale `tmux_target` after tmux renumbered the window | No |
| PTY geometry jumble | grid size mismatch — CUP escapes landed in wrong cells | No |
| Fullscreen render | window-size not driven to viewer grid | No |
| Typing auto-submits (Enter) | `send-keys -l` literal vs line-based path mismatch | No |

The existing `stream.test.ts` / `interact.test.ts` / `geometry-takeover.test.ts` suites all
drive a `MockPtySource` — they validate the `StreamManager` WS fan-out, writer mutex, and
geometry-frame plumbing at the **interface boundary**. That is correct and worth keeping. But
the component that actually composes the tmux argv — `TmuxPtySource` — has **zero** coverage:

1. It has no spawn seam (12 direct `Bun.spawn`/`Bun.spawnSync` calls), so the argv for
   `capture-pane`, `display-message`, `pipe-pane`, `send-keys -l`, `resize-window`, and
   `window-size manual`/restore is untestable in isolation. Tracked by `nx-h3zti`.
2. There is no end-to-end test that attaches to a **real** tmux pane and asserts the full
   round-trip (geometry frame, byte-exact scrollback, raw input without auto-Enter, resize
   reflow, teardown auto-restore).

This proposal closes both gaps so the next PTY regression fails a test before it ships.

## What Changes

### Tier 1 — Spawn seam + argv unit tests (API Batch, always-on)

- Add an injectable `SpawnFns` adapter to `TmuxPtySource` (constructor option, defaults to
  Bun's `spawn`/`spawnSync`). No behavior change in production — the default path is identical.
- Add `tmux-pty-source.test.ts`: inject a recording mock that captures every argv and returns
  canned results, then assert the **exact** argv for each operation. This is the unit that
  would have caught the `send-keys -l` literal-vs-line bug and the `window-size manual` gate.
- Closes `nx-h3zti`.

### Tier 2 — Real-tmux round-trip (E2E Batch, `hasTmux`-gated)

- Add a deterministic **TUI surrogate** fixture: a small bash/ANSI script (driven by
  `tput`/`printf`) whose output is fully controlled — NOT the real Claude TUI, which is
  non-deterministic and would make assertions flaky.
- Add `tmux-pty-source.integration.test.ts`: spin up a real tmux session running the surrogate,
  attach a `TmuxPtySource`, and assert the full round-trip. Gated by
  `describe.skipIf(!hasTmux)` so CI without tmux skips cleanly rather than failing.

## Context

- depends on: (none)
- touches: `apps/agent/src/terminal/tmux-pty-source.ts`, `apps/agent/src/terminal/tmux-pty-source.test.ts`, `apps/agent/src/terminal/tmux-pty-source.integration.test.ts`, `apps/agent/test/fixtures/tui-surrogate.sh`

## Non-Goals

- Testing against the real Claude TUI (non-deterministic output; surrogate only).
- Swift-side PTY viewer tests (separate target, not the agent).
- Changing any production tmux behavior — the seam defaults to Bun's spawn, byte-for-byte.

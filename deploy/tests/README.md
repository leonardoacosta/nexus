# deploy/tests

Bash-based tests for the launchd / shell-script side of nexus deployment.
These exist alongside (not inside) the Cargo workspace because they exercise
shell scripts and macOS launchd plists, not Rust crates.

| Test | Purpose | Platform |
| ---- | ------- | -------- |
| `nexus-notifier-modes.test.sh` | Unit-tests the `listen \| drain` mode dispatcher in `nexus-notifier.sh`. Stubs out the actual mode bodies, runs entirely in `bash`, no FIFO / network / audio. | Linux + macOS (CI-friendly) |
| `tts-queue-integration.sh` | Spins up `nexus-notifier.sh drain` with mocked paths, writes 3 lines to a temp FIFO, asserts the drain log shows 3 sequential entries ≥ 1s apart. | macOS only — auto-skips on Linux |

## Running

```bash
bash deploy/tests/nexus-notifier-modes.test.sh
bash deploy/tests/tts-queue-integration.sh   # no-op on Linux
```

Both scripts return exit 0 on success and non-zero on failure. They're
designed to be invoked directly from CI without any test-framework
dependencies (no bats, no jest, no vitest).

## Conventions

- Hand-rolled `assert_*` helpers (see `nexus-notifier-modes.test.sh`) — we
  intentionally don't pull in `bats` to keep the deploy surface dependency-free.
- Mock platform-specific commands (`say`, `curl`, `mkfifo`) via temp `PATH`
  shims or `sed`-rewritten copies of the script under test, so the test can
  run on hosts that don't have those binaries.
- Tests MUST clean up their temp files via `trap ... EXIT`.

## Spec references

- `openspec/changes/add-tts-playback-queue/` — the spec these tests verify.

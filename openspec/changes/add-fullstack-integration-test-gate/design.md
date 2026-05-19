# Design: add-fullstack-integration-test-gate

## Locked decisions (from /openspec:explore)

| Axis | Decision | Rationale |
| --- | --- | --- |
| Scope | Full suite — Tier A (headless) + Tier B (XCUITest) | Tier A catches faults #1/#3/#5-config; Tier B catches #4 (mount) + #5-runtime (ATS). Both needed. |
| Runner | Pre-push hook on the build machine; macOS/GUI guard for Tier B | No CI exists; deploy is git-hook-based. The macbook *is* the GUI runner. Headless hosts skip Tier B, never fail on it. |
| Transport | Split the seam | A-vs-B is a false binary — they test different halves. Costliest incident property was ambiguous signal, not missing e2e. |

## Why split the transport seam

- **Client gate → local stub, non-loopback bind.** Deterministic fixtures →
  exact assertions; clean signal (failure ⇒ the client, unambiguously);
  reproduces ATS because the failing factor is the real `.app` bundle's ATS
  policy + `http://` scheme, not the remote host. **Load-bearing caveat:**
  macOS exempts loopback/`*.local` from ATS, so a `127.0.0.1` stub is a
  false-green for the `-1022` class — the stub MUST bind a non-loopback
  address. Mock-divergence mitigated by snapshotting fixtures from the real
  agent and type-checking the stub against `packages/core`.
- **Homelab check → on-host loopback.** Catches the half the stub is blind to
  (agent bound loopback-only, response-shape drift, socket spine) without
  Tailscale flakiness, because it runs on the agent box against itself.
- **Real cross-host smoke → non-gating.** Preserves true-e2e signal as a
  fleet-liveness canary without letting homelab uptime red-fail unrelated
  client pushes.

## Rejected alternatives

- **Single real macbook→homelab e2e as the gate** — flaky (homelab/Tailscale
  state, varying session counts: observed 5→27→46 mid-incident), ambiguous
  signal (client? agent? network?), needs fleet uptime to push. This is the
  exact triage-hell the incident demonstrated.
- **Cloud CI** — none exists; XCUITest needs a GUI macOS runner; the deploy
  model is git-hook-based. Hook-gating matches the architecture.
- **Tier A only** — leaves #4 (SessionsView never mounts) and #5-runtime
  (ATS) uncaught; those two cost the most hours.

## Mechanism notes

- Tier B GUI guard: `uname -s = Darwin` AND a usable GUI session probe
  (e.g. `launchctl print gui/$(id -u)` succeeds and the session is not
  SSH-only). On SKIP, emit a explicit marker line so the SKIP is visible, not
  silent.
- Bundle build for tests uses `xcodebuild` directly (NOT `install.sh`, which
  silently no-ops — nx-5ws74). The bundle-integrity test asserts the produced
  bundle's Info.plist contains `NSAppTransportSecurity` + `LSUIElement` and
  the product is `nexus.app`; this retroactively guards the nx-5ws74 +
  ATS-config regression classes.
- Un-stub work (nx-qsj1 / nx-it4u / nx-3awz): replace placeholder bodies with
  real assertions against live PG; the session integration test asserts a
  known PID → process-watcher → `/sessions` returns it with fresh
  `lastActivity` (the nx-z66n8 regression surface).

## Out of scope

- Fixing nx-5ws74 / nx-p2zs5 themselves (this suite *guards* their fault
  classes; it builds via xcodebuild and asserts the bundle directly).
- Standing up cloud CI (explicitly rejected — hook-gating is the runner).

<!-- beads:epic:nx-ywqig -->
<!-- beads:feature:nx-l9b6f -->

# Implementation Tasks

## API Batch

- [ ] [2.1] Repro nx-qq3qu first (send keystrokes, confirm zero `NXPTY interact binary` log lines agent-side despite client-side success), then fix the agent-side dispatcher routing that's dropping the binary interact frame [owner:api-engineer] [type:api] [beads:nx-e7vgm]
- [ ] [2.2] Add `apps/agent/src/routes/apns-register.ts` (POST /apns/register, stores device token) and an APNS HTTP/2 dispatch path in `apps/agent/src/notifications/manager.ts` invoked on NotificationFired when the target app is killed (nx-q2u0d, ~500 LOC agent-side per bead estimate) [owner:api-engineer] [type:api] [beads:nx-u71wi]
- [x] [2.3] Extend `deploy/hooks.d/*/04-swift-deploy` + `deploy/lib/macos-swift-deploy.sh` to also build nexus-ios and run `xcrun devicectl device install app` against the paired iPhone via the existing GUI-agent LaunchAgent kickstart (nx-detes) [owner:devops-engineer] [type:ci-cd] [beads:nx-txuau]

## UI Batch

- [ ] [3.1] Fix `SshTerminalSession.send()` / iOS-side interact channel if the nx-qq3qu repro (task 2.1) isolates the bug client-side rather than agent-side [owner:swift-engineer] [type:ui] [beads:nx-6ptlo]
- [ ] [3.2] Add HealthKit read module: `HKAnchoredObjectQuery` with persisted incremental anchor for resting HR / HR / HRV, `HKObserverQuery` + background delivery, POST to `http://homelab:8796/ingest` in the Health Auto Export JSON shape, direct-to-homelab (not via the nexus agent) (nx-fkmao) [owner:swift-engineer] [type:ui] [beads:nx-jb1pr]

## E2E Batch

- [ ] [4.1] E2E: repeated keystrokes reliably reach `pty.write()` agent-side after the nx-qq3qu fix, zero DROPPED log lines [owner:e2e-engineer] [type:testing] [beads:nx-uql03]
- [ ] [4.2] Unit test for `/apns/register` route (stores token, non-404 response) [owner:tdd-integration] [type:testing] [beads:nx-xwnqx]
- [ ] [4.3] E2E: NotificationFired for a killed-app session results in an actual APNS send, verified via a mocked/sandboxed APNS endpoint [owner:e2e-engineer] [type:testing] [beads:nx-6syfl]
- [ ] [4.4] Manual on-device verification: HealthKit anchored query advances and a POST reaches mx-health ingest after a new sample [owner:swift-engineer] [type:testing] [beads:nx-ka2f7]
- [ ] [4.5] Produce the board-to-iOS-nav design note (rail selector / proposal rows / orphan beads / detail rail mapping) ending in an explicit go/no-go recommendation (nx-ghrhb) [owner:swift-engineer] [type:docs] [beads:nx-szfbk]
- [ ] [4.6] E2E: post-merge deploy dispatcher installs nexus-ios to a paired device with no manual devicectl intervention [owner:e2e-engineer] [type:testing] [beads:nx-td5tq]

---
status: draft
after: harden-agent-reliability-and-deploy-hooks — same triage pass batch, no shared files, ordered for triage convenience only
---

# Proposal: iOS companion follow-ups (5 beads)

## Change ID
`extend-ios-companion-features`

## Summary
Bundles 5 iOS/Swift companion items into one openspec change: a P1 regression in the
in-app PTY interact channel, closing the already-spec'd-but-never-agent-side-implemented APNS
push gap, a new HealthKit read+push module, a board-to-iOS-nav adoption spike, and extending
headless deploy to iOS device installs.

## Context
- Related: `mx-rkir.13` (fixed a prior instance of the same interact-frame bug class), `scaffold-nexus-ios-target` (archived — nexus-ios-client's original spec, still governs the SwiftTerm attach and APNS requirements this proposal modifies), `refocus-board-shell` (archived — the board this proposal's spike assesses porting)
- touches: `apps/swift/nexus-ios/`, `apps/agent/src/routes/apns-register.ts` (new), `apps/agent/src/notifications/manager.ts`, `deploy/hooks.d/*/04-swift-deploy`, `deploy/lib/macos-swift-deploy.sh`

## Motivation
- **nx-qq3qu (P1)**: iOS `SshTerminalSession.send()` logs success and calls
  `client.sendInteractiveInput()` with no client-side error, but the owning agent never
  receives ANY binary interact frame — confirmed via journalctl (zero
  "NXPTY interact binary -> pty.write()" AND zero "DROPPED" log lines despite repeated
  keystrokes). Same bug class `mx-rkir.13` was supposed to have fixed.
- **nx-q2u0d**: `nexus-ios-client`'s existing "SHALL receive APNS push notifications"
  requirement assumes a working agent-side dispatch path, but the agent has no
  `/apns/register` endpoint and no APNS HTTP/2 send path — the client already POSTs a device
  token to a route that doesn't exist. Only needed for app-killed delivery; local
  notifications already cover running/backgrounded.
- **nx-fkmao**: no HealthKit integration exists yet. This is the production producer for
  `mx-sqd`/`mx-4d0` (mx repo), replacing a manual Health Auto Export stopgap.
- **nx-ghrhb**: `refocus-board-shell` shipped the board on Mac; NexusShared already carries the
  client methods needed, so porting to iOS Scenes nav is UI-shape assessment only.
- **nx-detes**: the GUI-agent deploy pattern (`04-swift-deploy` + `macos-swift-deploy.sh`)
  exists for macOS codesigning but has no iOS equivalent — headless SSH device install fails at
  codesign, forcing manual `devicectl install` today.

## Requirements

### Requirement: nexus-ios SHALL embed SwiftTerm for in-app PTY attach
Tapping "Attach" on a session SHALL open a full-screen view rendering a SwiftTerm TerminalView, and every keystroke sent via `SshTerminalSession.send()` SHALL reach the owning agent's `pty.write()` as a binary interact frame — a client-side "send success" log with no corresponding agent-side interact-frame receipt is a regression, not a passing state.

### Requirement: nexus-ios SHALL receive APNS push notifications
The app SHALL register for APNS push notifications via a real agent-side `/apns/register` endpoint, and the agent SHALL dispatch an APNS push via HTTP/2 when it fires a `NotificationFired` event for a session whose app is not running/backgrounded (local notifications already cover the running/backgrounded case).

### Requirement: iOS HealthKit read and push to homelab mx-health ingest
The nexus-ios target SHALL read resting HR / HR / HRV via `HKAnchoredObjectQuery` with a
persisted incremental anchor, register `HKObserverQuery` + background delivery for
push-on-change, and POST the Health Auto Export JSON shape directly to the homelab mx-health
ingest endpoint over the tailnet (not routed through the nexus agent).

### Requirement: Board-to-iOS-nav adoption is assessed via a documented spike
A design note assessing how the project-structure board (rail selector, proposal rows, orphan
beads, detail rail) maps onto nexus-ios Scenes navigation SHALL be produced, ending in an
explicit go/no-go recommendation.

### Requirement: GUI-agent deploy SHALL extend to headless iOS device install
The GUI-agent deploy pattern (`dev.leonardoacosta.nexus.deploy`, gui/501 LaunchAgent) SHALL
extend to build nexus-ios and run `xcrun devicectl device install app` against the paired
iPhone, so iOS deploys no longer require manual intervention the way a headless SSH attempt
does today (codesign requires an Aqua session; even `git push` from SSH fails with keychain
error -25308).

## Scope
- **IN**: the 5 items above, scoped to each bead's described root cause/deliverable
- **OUT**: any broader iOS feature work beyond these 5 beads; Watch app changes (not requested)

## Testing
| Affected seam | Unit task | E2E task |
|----------------|-----------|----------|
| Interact-frame delivery | N/A | [4.1] repro keystroke -> confirm agent log shows `pty.write()` receipt, not silent drop |
| APNS agent-side dispatch | [4.2] `/apns/register` route unit test | [4.3] E2E: NotificationFired with app killed -> push delivered |
| HealthKit push module | N/A — device-only HealthKit APIs, no server-side unit surface | [4.4] manual on-device verification: anchored query + observer + POST to mx-health ingest |
| Board adoption spike | N/A | N/A — design-note deliverable, verified by presence + go/no-go content |
| iOS headless device install | N/A | [4.5] E2E: GUI-agent deploy run installs to a paired device without manual devicectl intervention |

## Impact
| Area | Change |
|------|--------|
| `apps/swift/nexus-ios/` (interact channel) | fix regression in `SshTerminalSession.send()` / agent dispatch routing |
| `apps/agent/src/routes/apns-register.ts` | new route |
| `apps/agent/src/notifications/manager.ts` | +APNS HTTP/2 dispatch path |
| `apps/swift/nexus-ios/` (HealthKit) | new module |
| `docs/` | new board-to-iOS-nav design note |
| `deploy/hooks.d/*/04-swift-deploy`, `deploy/lib/macos-swift-deploy.sh` | +iOS device install path |

## Risks
| Risk | Mitigation |
|------|-----------|
| nx-qq3qu regression's exact root cause (dispatcher routing vs client bug) not yet isolated | Task includes a repro-first step before attempting a fix |
| APNS cert/key management for HTTP/2 dispatcher | Scoped to agent config, same secrets pattern as other agent credentials |
| HealthKit background delivery reliability is iOS-OS-controlled, not fully guaranteed | Documented as a known iOS platform limitation, not a bug in this implementation |
